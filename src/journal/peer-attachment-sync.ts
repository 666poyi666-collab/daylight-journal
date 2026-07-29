import {
  base64Url,
  fromBase64Url,
  sha256,
  stableJson,
  type RootKeyBundle,
} from './encrypted-sync.ts'
import type { JournalEntries } from './model.ts'
import type { StorageLike } from './storage.ts'

export const PEER_ATTACHMENT_URL_STORAGE_KEY = 'daylight-journal-peer-attachment-url-v1'
export const PEER_ATTACHMENT_TOKEN_STORAGE_KEY = 'daylight-journal-peer-attachment-token-v1'

const MAX_PLAINTEXT_BYTES = 7_500_000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type PeerAttachmentEnvelopeV1 = {
  schemaVersion: 1
  date: string
  operation: 'upsert' | 'delete'
  updatedAt: string
  keyVersion: number
  nonce: string | null
  ciphertext: string | null
  ciphertextSha256: string | null
  aadHash: string
}

type ObservedPeerAttachment = {
  updatedAt: string
  fingerprint: string
}

export type PeerAttachmentSnapshotV1 = {
  schemaVersion: 1
  observed: Record<string, ObservedPeerAttachment>
  pending: Record<string, PeerAttachmentEnvelopeV1>
}

export interface PeerAttachmentStore {
  read(): Promise<PeerAttachmentSnapshotV1>
  write(snapshot: PeerAttachmentSnapshotV1): Promise<void>
}

type FetchLike = typeof fetch

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function isTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part))) return false
  const octets = parts.map(Number)
  if (octets.some((part) => part > 255)) return false
  return octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === '::1' ||
    /^f[cd][0-9a-f]*:/.test(host) ||
    /^fe[89ab][0-9a-f]*:/.test(host)
}

/**
 * Peer attachment endpoints must resolve directly on the same device or local
 * network. Public hosts and tunnel URLs are rejected before a request is sent.
 */
export function normalizePeerAttachmentUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '')
    ) return null
    const hostname = url.hostname.toLowerCase()
    if (
      hostname !== 'localhost' &&
      !hostname.endsWith('.local') &&
      !isPrivateIpv4(hostname) &&
      !isPrivateIpv6(hostname)
    ) return null
    return url.origin
  } catch {
    return null
  }
}

function attachmentAad(
  envelope: Pick<
    PeerAttachmentEnvelopeV1,
    'date' | 'operation' | 'updatedAt' | 'keyVersion'
  >,
) {
  return {
    schemaVersion: 1,
    product: 'journal',
    channel: 'peer_attachment',
    date: envelope.date,
    operation: envelope.operation,
    updatedAt: envelope.updatedAt,
    keyVersion: envelope.keyVersion,
  }
}

async function importRoot(root: RootKeyBundle): Promise<CryptoKey> {
  const raw = fromBase64Url(root.rawKey)
  if (
    raw.byteLength !== 32 ||
    !Number.isSafeInteger(root.keyVersion) ||
    root.keyVersion < 1
  ) throw new Error('invalid_root_key')
  return crypto.subtle.importKey(
    'raw',
    arrayBuffer(raw),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  )
}

function validateCoverImage(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ||
    encoder.encode(value).byteLength > MAX_PLAINTEXT_BYTES
  ) throw new Error('invalid_peer_attachment')
}

function envelopeKeysMatch(value: Record<string, unknown>): boolean {
  const expected = [
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
  const actual = Object.keys(value).sort()
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
}

export function validatePeerAttachmentEnvelope(
  value: unknown,
): PeerAttachmentEnvelopeV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_peer_attachment_envelope')
  }
  const record = value as Record<string, unknown>
  if (
    !envelopeKeysMatch(record) ||
    record.schemaVersion !== 1 ||
    typeof record.date !== 'string' ||
    !isDate(record.date) ||
    !['upsert', 'delete'].includes(String(record.operation)) ||
    typeof record.updatedAt !== 'string' ||
    !isTimestamp(record.updatedAt) ||
    !Number.isSafeInteger(record.keyVersion) ||
    Number(record.keyVersion) < 1 ||
    typeof record.aadHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.aadHash)
  ) throw new Error('invalid_peer_attachment_envelope')
  if (record.operation === 'delete') {
    if (
      record.nonce !== null ||
      record.ciphertext !== null ||
      record.ciphertextSha256 !== null
    ) throw new Error('invalid_peer_attachment_tombstone')
  } else if (
    typeof record.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{16}$/.test(record.nonce) ||
    typeof record.ciphertext !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(record.ciphertext) ||
    fromBase64Url(record.ciphertext).byteLength > 8 * 1024 * 1024 ||
    typeof record.ciphertextSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.ciphertextSha256)
  ) throw new Error('invalid_peer_attachment_ciphertext')
  return clone(record) as PeerAttachmentEnvelopeV1
}

export async function encryptPeerAttachment(
  root: RootKeyBundle,
  date: string,
  coverImage: string | null,
  updatedAt: string,
): Promise<PeerAttachmentEnvelopeV1> {
  if (!isDate(date) || !isTimestamp(updatedAt)) throw new Error('invalid_peer_attachment_metadata')
  const envelope: PeerAttachmentEnvelopeV1 = {
    schemaVersion: 1,
    date,
    operation: coverImage === null ? 'delete' : 'upsert',
    updatedAt,
    keyVersion: root.keyVersion,
    nonce: null,
    ciphertext: null,
    ciphertextSha256: null,
    aadHash: '',
  }
  const aad = stableJson(attachmentAad(envelope))
  envelope.aadHash = await sha256(aad)
  if (coverImage === null) return envelope
  validateCoverImage(coverImage)
  const clear = encoder.encode(JSON.stringify({ coverImage }))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: arrayBuffer(nonce),
      additionalData: arrayBuffer(encoder.encode(aad)),
    },
    await importRoot(root),
    arrayBuffer(clear),
  ))
  envelope.nonce = base64Url(nonce)
  envelope.ciphertext = base64Url(encrypted)
  envelope.ciphertextSha256 = await sha256(encrypted)
  return envelope
}

export async function decryptPeerAttachment(
  root: RootKeyBundle,
  input: PeerAttachmentEnvelopeV1,
): Promise<string> {
  const envelope = validatePeerAttachmentEnvelope(input)
  if (
    envelope.operation !== 'upsert' ||
    envelope.keyVersion !== root.keyVersion ||
    !envelope.nonce ||
    !envelope.ciphertext ||
    !envelope.ciphertextSha256
  ) throw new Error('undecryptable_peer_attachment')
  const aad = stableJson(attachmentAad(envelope))
  const encrypted = fromBase64Url(envelope.ciphertext)
  if (
    envelope.aadHash !== await sha256(aad) ||
    envelope.ciphertextSha256 !== await sha256(encrypted)
  ) throw new Error('peer_attachment_integrity_failed')
  let clear: ArrayBuffer
  try {
    clear = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(fromBase64Url(envelope.nonce)),
        additionalData: arrayBuffer(encoder.encode(aad)),
      },
      await importRoot(root),
      arrayBuffer(encrypted),
    )
  } catch {
    throw new Error('undecryptable_peer_attachment')
  }
  const payload = JSON.parse(decoder.decode(clear)) as unknown
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 1 ||
    !Object.hasOwn(payload, 'coverImage')
  ) throw new Error('invalid_peer_attachment_payload')
  const coverImage = (payload as { coverImage: unknown }).coverImage
  validateCoverImage(coverImage)
  return coverImage
}

function emptySnapshot(): PeerAttachmentSnapshotV1 {
  return { schemaVersion: 1, observed: {}, pending: {} }
}

function validateSnapshot(value: unknown): PeerAttachmentSnapshotV1 {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1
  ) throw new Error('invalid_peer_attachment_snapshot')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'observed,pending,schemaVersion' ||
    !record.observed ||
    typeof record.observed !== 'object' ||
    Array.isArray(record.observed) ||
    !record.pending ||
    typeof record.pending !== 'object' ||
    Array.isArray(record.pending)
  ) throw new Error('invalid_peer_attachment_snapshot')
  const observed: Record<string, ObservedPeerAttachment> = {}
  for (const [date, item] of Object.entries(record.observed as Record<string, unknown>)) {
    if (
      !isDate(date) ||
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'fingerprint,updatedAt'
    ) throw new Error('invalid_peer_attachment_snapshot')
    const observation = item as Record<string, unknown>
    if (
      typeof observation.updatedAt !== 'string' ||
      !isTimestamp(observation.updatedAt) ||
      typeof observation.fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(observation.fingerprint)
    ) throw new Error('invalid_peer_attachment_snapshot')
    observed[date] = {
      updatedAt: observation.updatedAt,
      fingerprint: observation.fingerprint,
    }
  }
  const pending: Record<string, PeerAttachmentEnvelopeV1> = {}
  for (const [date, item] of Object.entries(record.pending as Record<string, unknown>)) {
    const envelope = validatePeerAttachmentEnvelope(item)
    if (date !== envelope.date) throw new Error('invalid_peer_attachment_snapshot')
    pending[date] = envelope
  }
  return { schemaVersion: 1, observed, pending }
}

export class BrowserPeerAttachmentStore implements PeerAttachmentStore {
  private readonly key: string
  private readonly storage: StorageLike

  constructor(
    storage: StorageLike,
    peerUrl: string,
  ) {
    const normalized = normalizePeerAttachmentUrl(peerUrl)
    if (!normalized) throw new Error('invalid_peer_attachment_url')
    this.storage = storage
    this.key = `daylight-journal-peer-attachment-state-v1:${encodeURIComponent(normalized)}`
  }

  async read(): Promise<PeerAttachmentSnapshotV1> {
    const raw = this.storage.getItem(this.key)
    return raw ? validateSnapshot(JSON.parse(raw)) : emptySnapshot()
  }

  async write(snapshot: PeerAttachmentSnapshotV1): Promise<void> {
    this.storage.setItem(this.key, JSON.stringify(validateSnapshot(snapshot)))
  }
}

async function fingerprint(envelope: PeerAttachmentEnvelopeV1): Promise<string> {
  return await sha256(stableJson(envelope))
}

async function observation(
  envelope: PeerAttachmentEnvelopeV1,
): Promise<ObservedPeerAttachment> {
  return {
    updatedAt: envelope.updatedAt,
    fingerprint: await fingerprint(envelope),
  }
}

function withoutCover(entries: JournalEntries, date: string): void {
  const entry = entries[date]
  if (!entry || !Object.hasOwn(entry, 'coverImage')) return
  const { coverImage: _coverImage, ...rest } = entry
  entries[date] = rest
}

export class JournalPeerAttachmentClient {
  private readonly baseUrl: string
  private readonly pairingToken: string
  private readonly rootKey: RootKeyBundle
  private readonly store: PeerAttachmentStore
  private readonly fetcher: FetchLike

  constructor(
    peerUrl: string,
    pairingToken: string,
    rootKey: RootKeyBundle,
    store: PeerAttachmentStore,
    fetcher: FetchLike = fetch,
  ) {
    const normalized = normalizePeerAttachmentUrl(peerUrl)
    if (!normalized) throw new Error('invalid_peer_attachment_url')
    if (
      typeof pairingToken !== 'string' ||
      pairingToken.length < 32 ||
      !/^[A-Za-z0-9_-]+$/.test(pairingToken)
    ) throw new Error('invalid_peer_attachment_token')
    this.baseUrl = normalized
    this.pairingToken = pairingToken
    this.rootKey = rootKey
    this.store = store
    this.fetcher = fetcher
  }

  async queue(
    date: string,
    coverImage: string | null,
    updatedAt: string,
  ): Promise<void> {
    const envelope = await encryptPeerAttachment(
      this.rootKey,
      date,
      coverImage,
      updatedAt,
    )
    const state = clone(await this.store.read())
    const previous = state.pending[date]
    if (previous) {
      const comparison = Date.parse(envelope.updatedAt) - Date.parse(previous.updatedAt)
      if (comparison < 0) throw new Error('peer_attachment_pending_rollback')
      if (comparison === 0 && stableJson(previous) !== stableJson(envelope)) {
        throw new Error('peer_attachment_pending_divergence')
      }
    }
    state.pending[date] = envelope
    await this.store.write(state)
  }

  async synchronize(entries: JournalEntries): Promise<{
    entries: JournalEntries
    pendingCount: number
    commit: () => Promise<void>
  }> {
    const state = clone(await this.store.read())
    const remote = await this.#list()
    const remoteByDate = new Map(remote.map((envelope) => [envelope.date, envelope]))
    const merged = clone(entries)

    for (const envelope of remote) {
      const pending = state.pending[envelope.date]
      if (pending) {
        const comparison = Date.parse(envelope.updatedAt) - Date.parse(pending.updatedAt)
        if (comparison < 0) continue
        if (comparison === 0) {
          if (stableJson(envelope) !== stableJson(pending)) {
            throw new Error('peer_attachment_equal_timestamp_divergence')
          }
          delete state.pending[envelope.date]
          state.observed[envelope.date] = await observation(envelope)
          continue
        }
        delete state.pending[envelope.date]
      }

      const previous = state.observed[envelope.date]
      const nextFingerprint = await fingerprint(envelope)
      if (previous) {
        const comparison = Date.parse(envelope.updatedAt) - Date.parse(previous.updatedAt)
        if (comparison < 0) throw new Error('peer_attachment_revision_rollback')
        if (comparison === 0) {
          if (previous.fingerprint !== nextFingerprint) {
            throw new Error('peer_attachment_equal_timestamp_divergence')
          }
          continue
        }
      } else {
        const local = merged[envelope.date]
        if (local?.coverImage) {
          const comparison = Date.parse(local.updatedAt) - Date.parse(envelope.updatedAt)
          if (comparison > 0) {
            state.pending[envelope.date] = await encryptPeerAttachment(
              this.rootKey,
              envelope.date,
              local.coverImage,
              local.updatedAt,
            )
            continue
          }
          if (comparison === 0) {
            if (
              envelope.operation !== 'upsert' ||
              await decryptPeerAttachment(this.rootKey, envelope) !== local.coverImage
            ) throw new Error('peer_attachment_equal_timestamp_divergence')
            state.observed[envelope.date] = {
              updatedAt: envelope.updatedAt,
              fingerprint: nextFingerprint,
            }
            continue
          }
        }
      }

      if (envelope.operation === 'upsert') {
        const entry = merged[envelope.date]
        if (!entry) continue
        merged[envelope.date] = {
          ...entry,
          coverImage: await decryptPeerAttachment(this.rootKey, envelope),
        }
      } else {
        withoutCover(merged, envelope.date)
      }
      state.observed[envelope.date] = {
        updatedAt: envelope.updatedAt,
        fingerprint: nextFingerprint,
      }
    }

    for (const [date, entry] of Object.entries(merged)) {
      if (
        entry.coverImage &&
        !remoteByDate.has(date) &&
        !state.observed[date] &&
        !state.pending[date]
      ) {
        state.pending[date] = await encryptPeerAttachment(
          this.rootKey,
          date,
          entry.coverImage,
          entry.updatedAt,
        )
      }
    }
    if (Object.keys(state.pending).length) await this.store.write(state)

    for (const [date, envelope] of Object.entries(state.pending)
      .sort((left, right) => left[0].localeCompare(right[0]))) {
      const response = await this.fetcher(
        `${this.baseUrl}/v1/peer-attachments/${encodeURIComponent(date)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${this.pairingToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(envelope),
        },
      )
      if (!response.ok) throw new Error(`peer_attachment_push_failed:${response.status}`)
      const result = await response.json() as unknown
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        Object.keys(result).sort().join(',') !== 'envelope,replayed' ||
        typeof (result as { replayed?: unknown }).replayed !== 'boolean'
      ) throw new Error('invalid_peer_attachment_put_response')
      const accepted = validatePeerAttachmentEnvelope(
        (result as { envelope: unknown }).envelope,
      )
      if (stableJson(accepted) !== stableJson(envelope)) {
        throw new Error('peer_attachment_ack_mismatch')
      }
      state.observed[date] = await observation(envelope)
      delete state.pending[date]
    }

    const finalState = clone(state)
    return {
      entries: merged,
      pendingCount: Object.keys(finalState.pending).length,
      commit: async () => await this.store.write(finalState),
    }
  }

  async #list(): Promise<PeerAttachmentEnvelopeV1[]> {
    const response = await this.fetcher(`${this.baseUrl}/v1/peer-attachments`, {
      headers: { Authorization: `Bearer ${this.pairingToken}` },
    })
    if (!response.ok) throw new Error(`peer_attachment_pull_failed:${response.status}`)
    const raw = await response.text()
    if (raw.length > 12 * 1024 * 1024) throw new Error('peer_attachment_response_too_large')
    const value = JSON.parse(raw) as unknown
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'attachments,schemaVersion,serverTime'
    ) throw new Error('invalid_peer_attachment_list_response')
    const responseRecord = value as Record<string, unknown>
    if (
      responseRecord.schemaVersion !== 1 ||
      typeof responseRecord.serverTime !== 'string' ||
      !isTimestamp(responseRecord.serverTime) ||
      !Array.isArray(responseRecord.attachments)
    ) throw new Error('invalid_peer_attachment_list_response')
    const attachments = responseRecord.attachments.map(validatePeerAttachmentEnvelope)
    const dates = new Set<string>()
    for (const envelope of attachments) {
      if (dates.has(envelope.date)) throw new Error('duplicate_peer_attachment_record')
      dates.add(envelope.date)
    }
    return attachments
  }
}
