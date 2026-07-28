import assert from 'node:assert/strict'
import test from 'node:test'
import { JournalEncryptedSync, decryptAttachment, decryptMutation, encryptAttachment, encryptMutation, initializeRootKey, type SyncSnapshot } from '../src/journal/encrypted-sync.ts'

class MemoryStore {
  value: SyncSnapshot = { cursor: null, records: {}, outbox: [], attachments: {}, pendingDeletes: [] }
  async read() { return JSON.parse(JSON.stringify(this.value)) as SyncSnapshot }
  async write(value: SyncSnapshot) { this.value = JSON.parse(JSON.stringify(value)) as SyncSnapshot }
}

test('AES-GCM binds Journal mutations to immutable AAD', async () => {
  const root = await initializeRootKey()
  const mutation = await encryptMutation(root, { opId: crypto.randomUUID(), entityId: '2026-07-28', baseRevision: 0, operation: 'upsert' }, { title: 'private', blocks: ['private'] })
  assert.deepEqual(await decryptMutation(root, mutation), { title: 'private', blocks: ['private'] })
  await assert.rejects(() => decryptMutation(root, { ...mutation, entityId: '2026-07-29' }), /aad_mismatch/)
})

test('encrypted attachments reject tampering and retain resumable upload state', async () => {
  const root = await initializeRootKey(); const store = new MemoryStore(); const sync = new JournalEncryptedSync(store)
  const mutation = await encryptMutation(root, { opId: crypto.randomUUID(), entityId: '2026-07-28', baseRevision: 0, operation: 'upsert' }, { title: 'entry' })
  const attachment = await encryptAttachment(root, mutation, `journal_entry/2026-07-28/${mutation.opId}/cover`, new Uint8Array([1, 2, 3]))
  mutation.objects = [attachment.ref]; await sync.queue(mutation, [attachment]); await sync.markAttachmentUploaded(attachment.ref.objectKey)
  assert.deepEqual(await decryptAttachment(root, mutation, (await store.read()).attachments[attachment.ref.objectKey]), new Uint8Array([1, 2, 3]))
  const corrupt = {
    ...attachment,
    ciphertext: `${attachment.ciphertext[0] === 'A' ? 'B' : 'A'}${attachment.ciphertext.slice(1)}`,
  }
  await assert.rejects(() => decryptAttachment(root, mutation, corrupt), /attachment_integrity_failed/)
  const detached = await encryptAttachment(root, mutation, `journal_entry/2026-07-28/${mutation.opId}/detached`, new Uint8Array([4]))
  await assert.rejects(() => new JournalEncryptedSync(new MemoryStore()).queue(mutation, [detached]), /attachment_set_mismatch/)
})

test('exchange persists materialization, cursor and ACK atomically while retaining conflicts and tombstones', async () => {
  const root = await initializeRootKey(); const store = new MemoryStore(); const sync = new JournalEncryptedSync(store)
  const local = await encryptMutation(root, { opId: crypto.randomUUID(), entityId: '2026-07-28', baseRevision: 0, operation: 'upsert' }, { value: 1 })
  await sync.queue(local)
  const remote = await encryptMutation(root, { opId: crypto.randomUUID(), entityId: '2026-07-28', baseRevision: 0, operation: 'upsert' }, { value: 2 })
  await sync.applyExchange([{
    outcome: 'acknowledged',
    opId: local.opId,
    entityType: 'journal_entry',
    entityId: local.entityId,
    operation: local.operation,
    revision: 1,
  }], [], [{ ...remote, revision: 1, changedAt: '2026-07-28T00:00:00.000Z', originDeviceId: 'other', operationId: remote.opId }], 'c1')
  let state = await store.read(); assert.equal(state.outbox.length, 0); assert.equal(state.cursor, 'c1'); assert.equal(state.records['2026-07-28'].conflicts.length, 1)
  const deletion = await encryptMutation(root, { opId: crypto.randomUUID(), entityId: '2026-07-28', baseRevision: 1, operation: 'delete' }, null)
  await sync.applyExchange([], [], [{ ...deletion, revision: 2, changedAt: '2026-07-28T00:01:00.000Z', originDeviceId: 'other', operationId: deletion.opId }], 'c2')
  await sync.applyExchange([], [], [{ ...remote, revision: 1, changedAt: '2026-07-28T00:00:00.000Z', originDeviceId: 'other', operationId: remote.opId }], 'c2')
  state = await store.read(); assert.equal(state.records['2026-07-28'].deleted, true); assert.equal(state.records['2026-07-28'].revision, 2)
})

test('terminal server conflicts retain the queued candidate and reject forged ACKs', async () => {
  const root = await initializeRootKey(); const store = new MemoryStore(); const sync = new JournalEncryptedSync(store)
  const local = await encryptMutation(root, { opId: crypto.randomUUID(), entityId: '2026-07-28', baseRevision: 0, operation: 'upsert' }, { value: 'local' })
  const remote = await encryptMutation(root, { opId: crypto.randomUUID(), entityId: '2026-07-28', baseRevision: 0, operation: 'upsert' }, { value: 'remote' })
  await sync.queue(local)
  await assert.rejects(() => sync.applyExchange([{
    outcome: 'acknowledged',
    opId: local.opId,
    entityType: 'journal_entry',
    entityId: local.entityId,
    operation: local.operation,
    revision: 2,
  }], [], [], 'c0'), /unexpected_acknowledgement/)
  await sync.applyExchange([], [{
    outcome: 'conflict',
    opId: local.opId,
    entityType: 'journal_entry',
    entityId: local.entityId,
    operation: local.operation,
    error: 'REVISION_CONFLICT',
    current: {
      entityType: 'journal_entry',
      entityId: remote.entityId,
      revision: 1,
      operation: 'upsert',
      keyVersion: remote.keyVersion,
      ciphertext: remote.ciphertext,
      ciphertextSha256: remote.ciphertextSha256,
      nonce: remote.nonce,
      aadHash: remote.aadHash,
      objects: [],
      deletedAt: null,
      updatedAt: '2026-07-28T00:00:00.000Z',
    },
    candidate: null,
  }], [], 'c0')
  const state = await store.read()
  assert.equal(state.outbox.length, 0)
  assert.equal(state.records[local.entityId].conflicts.length, 1)
  assert.deepEqual(state.records[local.entityId].conflicts[0].candidate, local)
})
