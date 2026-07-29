import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_CIPHERTEXT_BYTES = 8 * 1024 * 1024
const ENVELOPE_KEYS = [
  'aadHash',
  'ciphertext',
  'ciphertextSha256',
  'date',
  'keyVersion',
  'nonce',
  'operation',
  'schemaVersion',
  'updatedAt',
]

export class PeerAttachmentStoreError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
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

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const parsed = new Date(`${date}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function validBase64Url(value, minimumLength = 1) {
  return typeof value === 'string' &&
    value.length >= minimumLength &&
    /^[A-Za-z0-9_-]+$/.test(value)
}

function decodedLength(value) {
  return Math.floor(value.length * 3 / 4)
}

export function validatePeerAttachmentEnvelope(value, expectedDate) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PeerAttachmentStoreError('INVALID_ENVELOPE', 'attachment envelope must be an object')
  }
  const keys = Object.keys(value).sort()
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((key, index) => key !== ENVELOPE_KEYS[index])) {
    throw new PeerAttachmentStoreError('INVALID_ENVELOPE', 'attachment envelope fields do not match V1')
  }
  if (
    value.schemaVersion !== 1 ||
    !validDate(value.date) ||
    (expectedDate !== undefined && value.date !== expectedDate) ||
    !['upsert', 'delete'].includes(value.operation) ||
    !validTimestamp(value.updatedAt) ||
    !Number.isSafeInteger(value.keyVersion) ||
    value.keyVersion < 1 ||
    typeof value.aadHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.aadHash)
  ) {
    throw new PeerAttachmentStoreError('INVALID_ENVELOPE', 'attachment envelope metadata is invalid')
  }
  if (value.operation === 'delete') {
    if (value.nonce !== null || value.ciphertext !== null || value.ciphertextSha256 !== null) {
      throw new PeerAttachmentStoreError('INVALID_ENVELOPE', 'attachment tombstone must not contain ciphertext')
    }
    return structuredClone(value)
  }
  if (
    !validBase64Url(value.nonce, 16) ||
    decodedLength(value.nonce) !== 12 ||
    !validBase64Url(value.ciphertext, 1) ||
    decodedLength(value.ciphertext) > MAX_CIPHERTEXT_BYTES ||
    typeof value.ciphertextSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.ciphertextSha256)
  ) {
    throw new PeerAttachmentStoreError('INVALID_ENVELOPE', 'attachment ciphertext metadata is invalid')
  }
  const nonce = Buffer.from(value.nonce, 'base64url')
  const ciphertext = Buffer.from(value.ciphertext, 'base64url')
  if (
    nonce.toString('base64url') !== value.nonce ||
    ciphertext.toString('base64url') !== value.ciphertext ||
    crypto.createHash('sha256').update(ciphertext).digest('hex') !== value.ciphertextSha256
  ) {
    throw new PeerAttachmentStoreError('INVALID_ENVELOPE', 'attachment ciphertext integrity is invalid')
  }
  return structuredClone(value)
}

async function readState(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'records,schemaVersion' ||
      value.schemaVersion !== 1 ||
      !value.records ||
      typeof value.records !== 'object' ||
      Array.isArray(value.records)
    ) {
      throw new Error('invalid_state')
    }
    const records = {}
    for (const [date, envelope] of Object.entries(value.records)) {
      records[date] = validatePeerAttachmentEnvelope(envelope, date)
    }
    return { schemaVersion: 1, records }
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, records: {} }
    if (error instanceof PeerAttachmentStoreError) throw error
    throw new PeerAttachmentStoreError(
      'DATA_CORRUPT',
      'peer attachment state is unreadable',
      503,
    )
  }
}

async function writeStateAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
  await fs.rename(temporary, file)
}

export class PeerAttachmentStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'journal-peer-attachments.json')
    this.queue = Promise.resolve()
  }

  async list() {
    return await this.#serialized(async () => {
      const state = await readState(this.file)
      return Object.values(state.records)
        .sort((left, right) => left.date.localeCompare(right.date))
        .map((value) => structuredClone(value))
    })
  }

  async put(date, input) {
    const envelope = validatePeerAttachmentEnvelope(input, date)
    return await this.#serialized(async () => {
      const state = await readState(this.file)
      const previous = state.records[date]
      if (previous) {
        const previousTime = Date.parse(previous.updatedAt)
        const nextTime = Date.parse(envelope.updatedAt)
        if (nextTime < previousTime) {
          throw new PeerAttachmentStoreError(
            'STALE_ATTACHMENT',
            'attachment timestamp is older than the current record',
            409,
            { currentUpdatedAt: previous.updatedAt },
          )
        }
        if (nextTime === previousTime) {
          if (digest(previous) === digest(envelope)) {
            return { envelope: structuredClone(previous), replayed: true }
          }
          throw new PeerAttachmentStoreError(
            'EQUAL_TIMESTAMP_DIVERGENCE',
            'equal attachment timestamps contain different encrypted state',
            409,
            { currentUpdatedAt: previous.updatedAt },
          )
        }
      }
      state.records[date] = envelope
      await writeStateAtomic(this.file, state)
      return { envelope: structuredClone(envelope), replayed: false }
    })
  }

  async #serialized(operation) {
    const run = this.queue.then(operation)
    this.queue = run.then(() => undefined, () => undefined)
    return await run
  }
}

export { MAX_CIPHERTEXT_BYTES }
