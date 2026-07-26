import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JournalStore, JournalStoreError } from '../../../journal-store.mjs'

const createId = '11111111-1111-4111-8111-111111111111'
const appendId = '22222222-2222-4222-8222-222222222222'
const updateId = '33333333-3333-4333-8333-333333333333'

async function withStore(operation) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-store-'))
  try {
    await operation(new JournalStore(dataDir), dataDir)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
}

test('JournalStore enforces integer revisions and persistent request replay', async () => {
  await withStore(async (store, dataDir) => {
    const created = await store.createEntry('2026-07-26', {
      requestId: createId,
      expectedRevision: 0,
      title: 'Contract entry',
      content: 'private-body-marker',
      mood: 4,
      tags: ['contract'],
    })
    assert.equal(created.revision, 1)
    assert.equal(created.replayed, false)

    const replayed = await new JournalStore(dataDir).createEntry('2026-07-26', {
      requestId: createId,
      expectedRevision: 0,
      title: 'Contract entry',
      content: 'private-body-marker',
      mood: 4,
      tags: ['contract'],
    })
    assert.equal(replayed.revision, 1)
    assert.equal(replayed.replayed, true)

    await assert.rejects(
      () => store.appendEntry('2026-07-26', {
        requestId: appendId,
        expectedRevision: 0,
        content: 'stale write',
      }),
      (error) => error instanceof JournalStoreError && error.code === 'REVISION_CONFLICT',
    )

    const appended = await store.appendEntry('2026-07-26', {
      requestId: appendId,
      expectedRevision: 1,
      content: 'second private marker',
    })
    assert.equal(appended.revision, 2)

    const updated = await store.updateEntry('2026-07-26', {
      requestId: updateId,
      expectedRevision: 2,
      patch: { mood: 5, tags: ['verified'] },
    })
    assert.equal(updated.revision, 3)
    const current = await store.getEntry('2026-07-26')
    assert.equal(current.revision, 3)
    assert.equal(current.entry.blocks.length, 2)

    await assert.rejects(
      () => store.updateEntry('2026-07-26', {
        requestId: updateId,
        expectedRevision: 3,
        patch: { mood: 1 },
      }),
      (error) => error instanceof JournalStoreError && error.code === 'REQUEST_ID_REUSED',
    )
  })
})

test('legacy synchronization advances the API revision', async () => {
  await withStore(async (store) => {
    const entry = {
      schemaVersion: 2,
      date: '2026-07-25',
      title: 'Legacy client',
      content: 'sync content',
      blocks: [],
      mood: null,
      tags: [],
      createdAt: '2026-07-25T08:00:00.000Z',
      updatedAt: '2026-07-25T08:00:00.000Z',
    }
    await store.mergeIncoming([entry])
    assert.equal((await store.getEntry(entry.date)).revision, 1)
    await store.mergeIncoming([{ ...entry, title: 'Changed', updatedAt: '2026-07-25T09:00:00.000Z' }])
    assert.equal((await store.getEntry(entry.date)).revision, 2)
  })
})
