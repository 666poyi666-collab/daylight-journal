import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { mergeIncomingEntries } from './sync-merge.mjs'

const REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000

export class JournalStoreError extends Error {
  constructor(code, message, status = 400, details = {}, retryable = false) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
    this.retryable = retryable
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  )
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw new JournalStoreError(
      'DATA_CORRUPT',
      `Stored JSON is not readable: ${path.basename(file)}`,
      503,
      {},
      true,
    )
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(temporary, file)
}

function validateDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new JournalStoreError('INVALID_ARGUMENT', 'date must use YYYY-MM-DD')
  }
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new JournalStoreError('INVALID_ARGUMENT', 'date is not valid')
  }
}

function validateRequestId(requestId) {
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new JournalStoreError('INVALID_ARGUMENT', 'requestId must be a UUID')
  }
}

function validateExpectedRevision(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new JournalStoreError('INVALID_ARGUMENT', 'expectedRevision must be a non-negative integer')
  }
}

function normalizeTags(value) {
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) {
    throw new JournalStoreError('INVALID_ARGUMENT', 'tags must be an array of strings')
  }
  return [...new Set(value.map((tag) => tag.trim()).filter(Boolean))].slice(0, 30)
}

function validateMood(value) {
  if (!(value === null || (Number.isInteger(value) && value >= 1 && value <= 5))) {
    throw new JournalStoreError('INVALID_ARGUMENT', 'mood must be null or an integer from 1 to 5')
  }
  return value
}

function summarize(entry, revision) {
  return {
    date: entry.date,
    title: entry.title,
    mood: entry.mood,
    tags: entry.tags,
    summary: entry.content.slice(0, 220),
    updatedAt: entry.updatedAt,
    revision,
    resourceUri: `journal://entries/${entry.date}`,
  }
}

function emptyEntry(date, now) {
  return {
    schemaVersion: 2,
    date,
    title: '',
    content: '',
    blocks: [],
    mood: null,
    tags: [],
    createdAt: now,
    updatedAt: now,
  }
}

function contentFromBlocks(blocks) {
  return blocks
    .filter((block) => block.content.trim())
    .map((block) => block.content)
    .join('\n\n---\n\n')
}

function blockForRequest(requestId, content, now) {
  return {
    id: `journal-${requestId}`,
    content,
    writeTimes: [now],
    writeStops: [{ sessionIndex: 0, offset: content.length, at: now }],
    createdAt: now,
    updatedAt: now,
  }
}

export class JournalStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.dataFile = path.join(dataDir, 'journals.json')
    this.stateFile = path.join(dataDir, 'journal-api-state.json')
    this.serviceFile = path.join(dataDir, 'journal-api-service.json')
    this.queue = Promise.resolve()
  }

  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true })
    const state = await readJson(this.serviceFile, null)
    if (state?.serviceId) return state
    const created = {
      serviceId: `journal-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
    }
    await writeJsonAtomic(this.serviceFile, created)
    return created
  }

  async readEntries() {
    const value = await readJson(this.dataFile, {})
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new JournalStoreError('DATA_CORRUPT', 'Journal data root must be an object', 503, {}, true)
    }
    return value
  }

  async status() {
    return await this._serialized(async () => {
      const service = await this.initialize()
      const { entries, state } = await this._snapshot()
      const values = Object.values(entries)
      const latest = values.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]
      return {
        service: 'journal-api',
        apiVersion: 1,
        serviceId: service.serviceId,
        state: 'ready',
        entryCount: values.length,
        latestUpdatedAt: latest?.updatedAt || null,
        revisionScheme: 'monotonic_integer',
        stateVersion: state.version,
      }
    })
  }

  async listEntries({ from, to, query = '', limit = 20, cursor = '' }) {
    if (from) validateDate(from)
    if (to) validateDate(to)
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20))
    const needle = String(query || '').trim().toLocaleLowerCase('zh-CN')
    return await this._serialized(async () => {
      const { entries, state } = await this._snapshot()
      const filtered = Object.values(entries)
        .filter((entry) => (!from || entry.date >= from) && (!to || entry.date <= to))
        .filter((entry) => !needle || `${entry.title}\n${entry.content}\n${entry.tags.join(' ')}`.toLocaleLowerCase('zh-CN').includes(needle))
        .sort((a, b) => b.date.localeCompare(a.date))
      const offset = cursor ? Number.parseInt(Buffer.from(cursor, 'base64url').toString('ascii'), 10) : 0
      if (!Number.isInteger(offset) || offset < 0) {
        throw new JournalStoreError('INVALID_ARGUMENT', 'cursor is invalid')
      }
      const items = filtered
        .slice(offset, offset + boundedLimit)
        .map((entry) => summarize(entry, state.entries[entry.date].revision))
      const nextOffset = offset + items.length
      return {
        items,
        count: items.length,
        nextCursor: nextOffset < filtered.length ? Buffer.from(String(nextOffset)).toString('base64url') : null,
        total: filtered.length,
      }
    })
  }

  async getEntry(date) {
    validateDate(date)
    return await this._serialized(async () => {
      const { entries, state } = await this._snapshot()
      const entry = entries[date]
      if (!entry) throw new JournalStoreError('NOT_FOUND', `No journal entry for ${date}`, 404)
      return { entry, revision: state.entries[date].revision }
    })
  }

  async mergeIncoming(incoming) {
    return await this._serialized(async () => {
      const { entries, state } = await this._snapshot()
      const merged = mergeIncomingEntries(entries, incoming)
      for (const [date, entry] of Object.entries(merged)) {
        const hash = digest(entry)
        const previous = state.entries[date]
        if (!previous || previous.hash !== hash) {
          state.entries[date] = { revision: (previous?.revision || 0) + 1, hash }
        }
      }
      await writeJsonAtomic(this.dataFile, merged)
      await writeJsonAtomic(this.stateFile, state)
      return Object.keys(merged).length
    })
  }

  async createEntry(date, body) {
    validateDate(date)
    this._validateWrite(body)
    if (body.expectedRevision !== 0) {
      throw new JournalStoreError('REVISION_CONFLICT', 'A new entry requires expectedRevision 0', 409, { currentRevision: 0 })
    }
    const title = typeof body.title === 'string' ? body.title : ''
    const content = typeof body.content === 'string' ? body.content : ''
    if (!title.trim() && !content.trim()) {
      throw new JournalStoreError('INVALID_ARGUMENT', 'title or content is required')
    }
    if (content.length > 100_000) {
      throw new JournalStoreError('INVALID_ARGUMENT', 'content exceeds 100000 characters')
    }
    return await this._writeOnce('create-entry', date, body, (current, now) => {
      if (current) throw new JournalStoreError('REVISION_CONFLICT', 'The journal entry already exists', 409)
      const blocks = content.trim() ? [blockForRequest(body.requestId, content, now)] : []
      return {
        ...emptyEntry(date, now),
        title,
        content: contentFromBlocks(blocks),
        blocks,
        mood: body.mood === undefined ? null : validateMood(body.mood),
        tags: body.tags === undefined ? [] : normalizeTags(body.tags),
      }
    })
  }

  async appendEntry(date, body) {
    validateDate(date)
    this._validateWrite(body)
    if (typeof body.content !== 'string' || !body.content.trim()) {
      throw new JournalStoreError('INVALID_ARGUMENT', 'content is required')
    }
    if (body.content.length > 100_000) {
      throw new JournalStoreError('INVALID_ARGUMENT', 'content exceeds 100000 characters')
    }
    return await this._writeOnce('append-entry', date, body, (current, now) => {
      if (!current) throw new JournalStoreError('NOT_FOUND', `No journal entry for ${date}`, 404)
      const blocks = [...current.blocks, blockForRequest(body.requestId, body.content, now)]
      return { ...current, blocks, content: contentFromBlocks(blocks), updatedAt: now }
    })
  }

  async updateEntry(date, body) {
    validateDate(date)
    this._validateWrite(body)
    const allowed = ['title', 'mood', 'tags']
    if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
      throw new JournalStoreError('INVALID_ARGUMENT', 'patch must be an object')
    }
    if (!Object.keys(body.patch).length || Object.keys(body.patch).some((key) => !allowed.includes(key))) {
      throw new JournalStoreError('INVALID_ARGUMENT', 'patch supports title, mood, and tags only')
    }
    return await this._writeOnce('update-entry', date, body, (current, now) => {
      if (!current) throw new JournalStoreError('NOT_FOUND', `No journal entry for ${date}`, 404)
      const patch = {}
      if ('title' in body.patch) {
        if (typeof body.patch.title !== 'string') throw new JournalStoreError('INVALID_ARGUMENT', 'title must be a string')
        patch.title = body.patch.title
      }
      if ('mood' in body.patch) patch.mood = validateMood(body.patch.mood)
      if ('tags' in body.patch) patch.tags = normalizeTags(body.patch.tags)
      return { ...current, ...patch, updatedAt: now }
    })
  }

  _validateWrite(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new JournalStoreError('INVALID_ARGUMENT', 'request body must be an object')
    }
    validateRequestId(body.requestId)
    validateExpectedRevision(body.expectedRevision)
  }

  async _writeOnce(scope, date, body, buildTarget) {
    return await this._serialized(async () => {
      const fingerprint = digest({ scope, date, body })
      const { entries, state } = await this._snapshot()
      this._cleanupRequests(state)
      const previous = state.requests[body.requestId]
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          throw new JournalStoreError('REQUEST_ID_REUSED', 'requestId was already used with a different payload', 409)
        }
        if (previous.state === 'completed') return { ...previous.result, replayed: true }
        return await this._recoverPending(entries, state, body.requestId, previous)
      }

      const current = entries[date]
      const currentRevision = current ? state.entries[date].revision : 0
      if (body.expectedRevision !== currentRevision) {
        throw new JournalStoreError(
          'REVISION_CONFLICT',
          'expectedRevision does not match the current entry',
          409,
          { expectedRevision: body.expectedRevision, currentRevision },
        )
      }
      const now = new Date().toISOString()
      const targetEntry = buildTarget(current, now)
      const targetRevision = currentRevision + 1
      const result = { entry: summarize(targetEntry, targetRevision), revision: targetRevision, replayed: false }
      const pending = {
        scope,
        date,
        fingerprint,
        state: 'pending',
        baseRevision: currentRevision,
        baseHash: current ? digest(current) : null,
        targetRevision,
        targetHash: digest(targetEntry),
        targetEntry,
        result,
        createdAt: now,
      }
      state.requests[body.requestId] = pending
      await writeJsonAtomic(this.stateFile, state)
      entries[date] = targetEntry
      await writeJsonAtomic(this.dataFile, entries)
      state.entries[date] = { revision: targetRevision, hash: pending.targetHash }
      state.requests[body.requestId] = this._completedRecord(pending)
      await writeJsonAtomic(this.stateFile, state)
      return result
    })
  }

  async _recoverPending(entries, state, requestId, pending) {
    const current = entries[pending.date]
    const currentHash = current ? digest(current) : null
    if (currentHash === pending.baseHash) {
      entries[pending.date] = pending.targetEntry
      await writeJsonAtomic(this.dataFile, entries)
    } else if (currentHash !== pending.targetHash) {
      throw new JournalStoreError(
        'RECOVERY_CONFLICT',
        'A pending request cannot be replayed over a newer revision',
        409,
        { currentRevision: state.entries[pending.date]?.revision || 0, targetRevision: pending.targetRevision },
      )
    }
    state.entries[pending.date] = { revision: pending.targetRevision, hash: pending.targetHash }
    state.requests[requestId] = this._completedRecord(pending)
    await writeJsonAtomic(this.stateFile, state)
    return { ...pending.result, replayed: true }
  }

  _completedRecord(pending) {
    const { targetEntry: _targetEntry, baseHash: _baseHash, targetHash: _targetHash, ...record } = pending
    return { ...record, state: 'completed', completedAt: new Date().toISOString() }
  }

  _cleanupRequests(state) {
    const cutoff = Date.now() - REQUEST_TTL_MS
    for (const [requestId, request] of Object.entries(state.requests)) {
      if (request.state === 'completed' && Date.parse(request.completedAt || request.createdAt) < cutoff) {
        delete state.requests[requestId]
      }
    }
  }

  async _snapshot() {
    const entries = await this.readEntries()
    const state = await readJson(this.stateFile, { version: 1, entries: {}, requests: {} })
    state.version = 1
    state.entries ||= {}
    state.requests ||= {}
    let changed = false
    for (const [date, entry] of Object.entries(entries)) {
      const hash = digest(entry)
      const previous = state.entries[date]
      if (!previous || previous.hash !== hash) {
        state.entries[date] = { revision: (previous?.revision || 0) + 1, hash }
        changed = true
      }
    }
    for (const date of Object.keys(state.entries)) {
      if (!entries[date]) {
        delete state.entries[date]
        changed = true
      }
    }
    if (changed) await writeJsonAtomic(this.stateFile, state)
    return { entries, state }
  }

  async _serialized(operation) {
    const run = this.queue.then(operation)
    this.queue = run.then(() => undefined, () => undefined)
    return await run
  }
}

export { digest, summarize }
