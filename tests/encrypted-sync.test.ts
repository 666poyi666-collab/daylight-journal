import assert from 'node:assert/strict'
import test from 'node:test'
import { JournalEncryptedSync, decryptAttachment, decryptMutation, encryptAttachment, encryptMutation, initializeRootKey, type SyncSnapshot } from '../src/journal/encrypted-sync.ts'

class MemoryStore {
  value: SyncSnapshot = { cursor: null, records: {}, outbox: [], attachments: {} }
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
  const corrupt = { ...attachment, ciphertext: `${attachment.ciphertext.slice(0, -1)}A` }
  await assert.rejects(() => decryptAttachment(root, mutation, corrupt), /attachment_integrity_failed/)
})

test('exchange persists materialization, cursor and ACK atomically while retaining conflicts and tombstones', async () => {
  const root = await initializeRootKey(); const store = new MemoryStore(); const sync = new JournalEncryptedSync(store)
  const local = await encryptMutation(root, { opId: crypto.randomUUID(), entityId: '2026-07-28', baseRevision: 0, operation: 'upsert' }, { value: 1 })
  await sync.queue(local)
  const remote = await encryptMutation(root, { opId: crypto.randomUUID(), entityId: '2026-07-28', baseRevision: 0, operation: 'upsert' }, { value: 2 })
  await sync.applyExchange([{ opId: local.opId, revision: 1 }], [{ ...remote, revision: 1, changedAt: '2026-07-28T00:00:00.000Z', originDeviceId: 'other', operationId: remote.opId }], 'c1')
  let state = await store.read(); assert.equal(state.outbox.length, 0); assert.equal(state.cursor, 'c1'); assert.equal(state.records['2026-07-28'].conflicts.length, 1)
  const deletion = await encryptMutation(root, { opId: crypto.randomUUID(), entityId: '2026-07-28', baseRevision: 1, operation: 'delete' }, null)
  await sync.applyExchange([], [{ ...deletion, revision: 2, changedAt: '2026-07-28T00:01:00.000Z', originDeviceId: 'other', operationId: deletion.opId }], 'c2')
  await sync.applyExchange([], [{ ...remote, revision: 1, changedAt: '2026-07-28T00:00:00.000Z', originDeviceId: 'other', operationId: remote.opId }], 'c2')
  state = await store.read(); assert.equal(state.records['2026-07-28'].deleted, true); assert.equal(state.records['2026-07-28'].revision, 2)
})
