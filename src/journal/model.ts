export type JournalTextColor = 'ink' | 'sage' | 'terracotta'

export type JournalWriteStop = {
  sessionIndex: number
  offset: number
  at: string
}

export type JournalBlock = {
  id: string
  content: string
  writeTimes: string[]
  writeStops: JournalWriteStop[]
  textColor?: JournalTextColor
  createdAt: string
  updatedAt: string
}

export type JournalEntry = {
  schemaVersion: 2
  date: string
  title: string
  content: string
  blocks: JournalBlock[]
  mood: number | null
  tags: string[]
  coverImage?: string
  createdAt: string
  updatedAt: string
}

export type JournalEntries = Record<string, JournalEntry>

export type DecodeEntriesResult = {
  entries: JournalEntries
  invalidKeys: string[]
  invalidRoot: boolean
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isJournalTextColor(value: unknown): value is JournalTextColor {
  return value === 'ink' || value === 'sage' || value === 'terracotta'
}

function legacyBlock(date: string, content: string, createdAt: string, updatedAt: string): JournalBlock {
  return {
    id: `legacy-${date}`,
    content,
    writeTimes: content.trim() ? [createdAt] : [],
    writeStops: content.trim()
      ? [{ sessionIndex: 0, offset: content.length, at: updatedAt }]
      : [],
    createdAt,
    updatedAt,
  }
}

function parseJournalBlock(value: unknown): JournalBlock | null {
  if (!isPlainRecord(value) || typeof value.id !== 'string' || !value.id) return null
  if (
    typeof value.content !== 'string' ||
    !Array.isArray(value.writeTimes) ||
    !value.writeTimes.every(isTimestamp) ||
    (value.textColor !== undefined && !isJournalTextColor(value.textColor)) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    return null
  }
  const content = value.content as string
  const writeTimes = value.writeTimes as string[]
  const writeStops = value.writeStops === undefined
    ? (content.trim() && writeTimes.length
        ? [{
            sessionIndex: writeTimes.length - 1,
            offset: content.length,
            at: value.updatedAt,
          }]
        : [])
    : value.writeStops
  if (
    !Array.isArray(writeStops) ||
    !writeStops.every((stop) =>
      isPlainRecord(stop) &&
      typeof stop.sessionIndex === 'number' &&
      Number.isInteger(stop.sessionIndex) &&
      stop.sessionIndex >= 0 &&
      stop.sessionIndex < writeTimes.length &&
      typeof stop.offset === 'number' &&
      Number.isInteger(stop.offset) &&
      stop.offset >= 0 &&
      stop.offset <= content.length &&
      isTimestamp(stop.at),
    )
  ) {
    return null
  }
  return {
    id: value.id,
    content,
    writeTimes: [...writeTimes],
    writeStops: writeStops.map((stop) => ({
      sessionIndex: stop.sessionIndex as number,
      offset: stop.offset as number,
      at: stop.at as string,
    })),
    ...(value.textColor === undefined ? {} : { textColor: value.textColor }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

/** Build the legacy plain-text mirror used by search, export and older clients. */
/**
 * 把正文压成一行摘要：去掉记录片之间的 `---` 分隔符和多余空白。
 * 只用于列表和卡片预览，不改变存储与同步用的正文本身。
 */
export function journalPreviewText(content: string): string {
  return content
    .replace(/^[ \t]*-{3,}[ \t]*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function journalBlocksToContent(blocks: JournalBlock[]): string {
  return blocks
    .filter((block) => Boolean(block.content.trim()))
    .map((block) => block.content)
    .join('\n\n---\n\n')
}

export function createJournalBlock(
  date: string,
  now = new Date().toISOString(),
  id = `block-${date}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
): JournalBlock {
  return { id, content: '', writeTimes: [], writeStops: [], createdAt: now, updatedAt: now }
}

function parseJournalEntry(value: unknown): JournalEntry | null {
  if (!isPlainRecord(value)) return null
  const mood = value.mood
  const tags = value.tags
  if (
    !isDateKey(value.date) ||
    typeof value.title !== 'string' ||
    typeof value.content !== 'string' ||
    !(mood === null || (typeof mood === 'number' && Number.isInteger(mood) && mood >= 1 && mood <= 5)) ||
    !Array.isArray(tags) ||
    !tags.every((tag) => typeof tag === 'string') ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    (value.coverImage !== undefined && typeof value.coverImage !== 'string')
  ) {
    return null
  }
  let blocks: JournalBlock[]
  if (value.schemaVersion === 2 || value.blocks !== undefined) {
    if (!Array.isArray(value.blocks)) return null
    const parsedBlocks = value.blocks.map(parseJournalBlock)
    if (parsedBlocks.some((block) => block === null)) return null
    blocks = parsedBlocks as JournalBlock[]
    if (new Set(blocks.map((block) => block.id)).size !== blocks.length) return null
  } else {
    blocks = [legacyBlock(value.date, value.content, value.createdAt, value.updatedAt)]
  }
  if (!blocks.length) {
    blocks = [createJournalBlock(value.date, value.createdAt, `draft-${value.date}`)]
  }
  return {
    schemaVersion: 2,
    date: value.date,
    title: value.title,
    content: journalBlocksToContent(blocks),
    blocks,
    mood,
    tags,
    ...(value.coverImage === undefined ? {} : { coverImage: value.coverImage }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

/** Decode untrusted local or remote journal data without throwing. */
export function decodeJournalEntries(value: unknown): DecodeEntriesResult {
  if (!isPlainRecord(value)) {
    return { entries: {}, invalidKeys: [], invalidRoot: true }
  }

  const entries: JournalEntries = {}
  const invalidKeys: string[] = []
  for (const [key, candidate] of Object.entries(value)) {
    const parsed = parseJournalEntry(candidate)
    if (!parsed || parsed.date !== key) {
      invalidKeys.push(key)
      continue
    }
    entries[key] = parsed
  }

  return { entries, invalidKeys, invalidRoot: false }
}

export function hasEntryContent(entry?: JournalEntry): boolean {
  return Boolean(
    entry && (entry.title.trim() || entry.content.trim() || entry.coverImage),
  )
}

export function hasReviewableText(entry?: JournalEntry): boolean {
  return Boolean(entry && (entry.title.trim() || entry.content.trim()))
}

export function emptyEntry(date: string, now = new Date().toISOString()): JournalEntry {
  return {
    schemaVersion: 2,
    date,
    title: '',
    content: '',
    blocks: [createJournalBlock(date, now, `draft-${date}`)],
    mood: null,
    tags: [],
    createdAt: now,
    updatedAt: now,
  }
}

function entryTimestamp(entry: JournalEntry): number {
  const value = Date.parse(entry.updatedAt || entry.createdAt)
  return Number.isFinite(value) ? value : 0
}

/** Merge local and remote entries, keeping the newest revision for each date. */
export function mergeEntries(
  local: JournalEntries,
  remote: JournalEntries,
): JournalEntries {
  const merged = { ...remote }
  for (const [date, entry] of Object.entries(local)) {
    const remoteEntry = remote[date]
    if (!remoteEntry || entryTimestamp(entry) >= entryTimestamp(remoteEntry)) {
      merged[date] = entry
    }
  }
  return merged
}

/** Apply a partial edit against the latest entry snapshot for a date. */
export function applyEntryPatch(
  entries: JournalEntries,
  date: string,
  patch: Partial<JournalEntry>,
  now = new Date().toISOString(),
): JournalEntries {
  const current = entries[date] || emptyEntry(date, now)
  const next = { ...current, ...patch, date, updatedAt: now }
  const blocks = patch.blocks !== undefined ? patch.blocks : (
    patch.content !== undefined && patch.content !== current.content
      ? [{
          ...(current.blocks[0] || createJournalBlock(date, current.createdAt)),
          content: patch.content,
          writeTimes: current.blocks[0]?.writeTimes.length || !patch.content.trim()
            ? current.blocks[0]?.writeTimes || []
            : [now],
          updatedAt: now,
        }]
      : next.blocks
  )
  return {
    ...entries,
    [date]: {
      ...next,
      schemaVersion: 2,
      blocks,
      content: journalBlocksToContent(blocks),
    },
  }
}
