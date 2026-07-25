import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyEntryPatch,
  decodeJournalEntries,
  emptyEntry,
  hasReviewableText,
  journalBlocksToContent,
  mergeEntries,
} from '../src/journal/model.ts'
import {
  loadJournalEntries,
  persistJournalEntries,
  type StorageLike,
} from '../src/journal/storage.ts'

function validEntry(date = '2026-07-22') {
  const entry = emptyEntry(date, '2026-07-22T08:00:00.000Z')
  const blocks = [{
    ...entry.blocks[0],
    content: '正文',
    writeTimes: ['2026-07-22T08:00:30.000Z'],
    textColor: 'sage' as const,
    updatedAt: '2026-07-22T08:01:00.000Z',
  }]
  return {
    ...entry,
    title: '标题',
    content: journalBlocksToContent(blocks),
    blocks,
    updatedAt: '2026-07-22T08:01:00.000Z',
  }
}

class MemoryStorage implements StorageLike {
  values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

test('decodeJournalEntries isolates malformed records', () => {
  const result = decodeJournalEntries({
    '2026-07-22': validEntry(),
    broken: { date: 'broken', title: 1 },
  })
  assert.deepEqual(Object.keys(result.entries), ['2026-07-22'])
  assert.deepEqual(result.invalidKeys, ['broken'])
  assert.equal(result.invalidRoot, false)
  assert.equal(decodeJournalEntries(null).invalidRoot, true)
  assert.deepEqual(
    decodeJournalEntries({
      '2026-99-99': { ...validEntry(), date: '2026-99-99' },
    }).invalidKeys,
    ['2026-99-99'],
  )
})

test('decodeJournalEntries deterministically migrates legacy content to blocks', () => {
  const legacy = validEntry()
  const { schemaVersion: _schemaVersion, blocks: _blocks, ...legacyValue } = legacy
  const first = decodeJournalEntries({ [legacy.date]: legacyValue }).entries[legacy.date]
  const second = decodeJournalEntries({ [legacy.date]: legacyValue }).entries[legacy.date]
  assert.equal(first.schemaVersion, 2)
  assert.equal(first.blocks[0].id, `legacy-${legacy.date}`)
  assert.equal(first.blocks[0].id, second.blocks[0].id)
  assert.equal(first.blocks[0].content, legacy.content)
  assert.deepEqual(first.blocks[0].writeTimes, [legacy.createdAt])
  assert.deepEqual(first, second)
})

test('decodeJournalEntries rejects invalid v2 blocks without affecting valid dates', () => {
  const valid = validEntry()
  const missingBlocks = validEntry('2026-07-26')
  const { blocks: _blocks, ...v2WithoutBlocks } = missingBlocks
  const result = decodeJournalEntries({
    [valid.date]: valid,
    '2026-07-23': {
      ...validEntry('2026-07-23'),
      blocks: [{ ...valid.blocks[0], id: 'bad-time', writeTimes: ['not-a-time'] }],
    },
    '2026-07-24': {
      ...validEntry('2026-07-24'),
      blocks: [valid.blocks[0], { ...valid.blocks[0], content: '重复 id' }],
    },
    '2026-07-25': {
      ...validEntry('2026-07-25'),
      blocks: '不是数组',
    },
    '2026-07-26': v2WithoutBlocks,
    '2026-07-27': {
      ...validEntry('2026-07-27'),
      blocks: [{ ...valid.blocks[0], id: 'bad-color', textColor: 'neon' }],
    },
    '2026-07-28': {
      ...validEntry('2026-07-28'),
      blocks: [{
        ...valid.blocks[0],
        id: 'bad-stop',
        writeStops: [{ sessionIndex: 0, offset: 999, at: valid.updatedAt }],
      }],
    },
  })
  assert.deepEqual(Object.keys(result.entries), [valid.date])
  assert.deepEqual(
    result.invalidKeys,
    ['2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26', '2026-07-27', '2026-07-28'],
  )
})

test('block content keeps a compatible plain-text mirror', () => {
  const entry = validEntry()
  const blocks = [
    { ...entry.blocks[0], id: 'one', content: '第一段' },
    { ...entry.blocks[0], id: 'two', content: '第二段' },
  ]
  assert.equal(journalBlocksToContent(blocks), '第一段\n\n---\n\n第二段')
  const updated = applyEntryPatch({ [entry.date]: entry }, entry.date, { blocks })
  assert.equal(updated[entry.date].content, '第一段\n\n---\n\n第二段')
  const decoded = decodeJournalEntries({
    [entry.date]: { ...entry, content: '过期镜像', blocks },
  }).entries[entry.date]
  assert.equal(decoded.content, '第一段\n\n---\n\n第二段')

  const spacedBlocks = [
    { ...entry.blocks[0], id: 'spaced', content: '  保留段内空白\n' },
    { ...entry.blocks[0], id: 'blank', content: '   ' },
  ]
  assert.equal(journalBlocksToContent(spacedBlocks), '  保留段内空白\n')
})

test('write session starts and inline stops survive persistence unchanged', () => {
  const storage = new MemoryStorage()
  const entry = validEntry()
  const writeTimes = [
    '2026-07-22T08:00:30.000Z',
    '2026-07-22T10:30:45.000Z',
  ]
  entry.blocks[0] = { ...entry.blocks[0], writeTimes }
  entry.blocks[0].writeStops = [
    { sessionIndex: 0, offset: 1, at: '2026-07-22T08:04:00.000Z' },
    { sessionIndex: 1, offset: 2, at: '2026-07-22T10:35:00.000Z' },
  ]

  assert.equal(persistJournalEntries({ [entry.date]: entry }, storage).ok, true)
  const loaded = loadJournalEntries(storage)
  assert.equal(loaded.issue, null)
  assert.deepEqual(loaded.entries[entry.date].blocks[0].writeTimes, writeTimes)
  assert.deepEqual(
    loaded.entries[entry.date].blocks[0].writeStops,
    entry.blocks[0].writeStops,
  )
  assert.equal(loaded.entries[entry.date].blocks[0].textColor, 'sage')
})

test('mergeEntries keeps the newest local revision', () => {
  const local = validEntry()
  const remote = { ...validEntry(), title: '旧标题', updatedAt: '2026-07-22T07:00:00.000Z' }
  const merged = mergeEntries({ [local.date]: local }, { [remote.date]: remote })
  assert.equal(merged[local.date].title, '标题')
})

test('applyEntryPatch reads the latest snapshot for async updates', () => {
  const first = validEntry()
  const edited = applyEntryPatch({ [first.date]: first }, first.date, {
    content: '用户随后输入的正文',
  }, '2026-07-22T08:02:00.000Z')
  const withImage = applyEntryPatch(edited, first.date, {
    coverImage: 'data:image/jpeg;base64,abc',
  }, '2026-07-22T08:03:00.000Z')
  assert.equal(withImage[first.date].content, '用户随后输入的正文')
  assert.equal(hasReviewableText(withImage[first.date]), true)
  assert.equal(hasReviewableText({ ...withImage[first.date], title: '', content: '' }), false)
})

test('storage adapter reports malformed data and quota failures', () => {
  const storage = new MemoryStorage()
  storage.values.set('daylight-journal-entries-v1', '{')
  const corrupt = loadJournalEntries(storage)
  assert.equal(corrupt.issue, 'corrupt')
  assert.equal(corrupt.raw, '{')

  const persisted = persistJournalEntries({ '2026-07-22': validEntry() }, storage)
  assert.equal(persisted.ok, true)
  assert.equal(loadJournalEntries(storage).issue, null)

  const quotaStorage: StorageLike = {
    getItem: () => null,
    setItem: () => {
      throw new DOMException('full', 'QuotaExceededError')
    },
  }
  const failed = persistJournalEntries({ '2026-07-22': validEntry() }, quotaStorage)
  assert.deepEqual(failed, { ok: false, issue: 'quota' })
})
