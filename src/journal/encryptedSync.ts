import { journalBinaryFetch, journalFetch } from './http.ts'
import { decodeJournalEntries, type JournalEntries, type JournalEntry } from './model.ts'

export const JOURNAL_SYNC_PROTOCOL_VERSION = 2 as const
export const JOURNAL_SYNC_ENVELOPE_VERSION = 1 as const

type JsonRecord = Record<string, unknown>
type SyncOperation = 'upsert' | 'delete'

export type JournalEncryptedObject = {
  objectKey: string
  ciphertextSha256: string
  ciphertextBytes: number
  nonce: string
  aadHash: string
  keyVersion: number
}

export type JournalEncryptedMutation = {
  opId: string
  entityType: 'journal_entry'
  entityId: string
  baseRevision: number
  operation: SyncOperation
  keyVersion: number
  ciphertext: string | null
  nonce: string | null
  aadHash: string
  objects: JournalEncryptedObject[]
}

type JournalEncryptedChange = Omit<JournalEncryptedMutation, 'opId' | 'baseRevision'> & {
  revision: number
  changedAt: string
  originDeviceId: string
  operationId: string
}

type JournalAcknowledgement = {
  outcome: 'acknowledged'
  opId: string
  entityType: 'journal_entry'
  entityId: string
  operation: SyncOperation
  revision: number
  replayed?: boolean
}

type JournalConflict = {
  outcome: 'conflict'
  opId: string
  entityType: 'journal_entry'
  entityId: string
  operation: SyncOperation
  error: string
  retryable?: boolean
  current: JournalEncryptedChange | null
  candidate: JournalEncryptedMutation | null
}

type JournalExchangeResponse = {
  protocolVersion: 2
  envelopeVersion: 1
  product: 'journal'
  acknowledged: JournalAcknowledgement[]
  conflicts: JournalConflict[]
  changes: JournalEncryptedChange[]
  nextCursor: string
  hasMore: boolean
  serverTime: string
}

type WrappedRootKey = {
  ciphertext: string
  nonce: string
}

type SyncIdentity = {
  key: 'identity-v1'
  deviceId: string
  deviceWrappingKey: CryptoKey
  agreementPrivateKey: CryptoKey
  agreementPublicKey: CryptoKey
  publicAgreementJwk: JsonWebKey
  wrappedRootKey: WrappedRootKey | null
  rootFingerprint: string | null
  approvalRequest: ApprovalRequest | null
}

type ApprovalRequest = {
  nonce: string
  createdAt: number
  expiresAt: number
}

type LocalEntity = {
  entityId: string
  entry: JournalEntry | null
  localFingerprint: string | null
  confirmedRevision: number
  confirmedFingerprint: string | null
  deleted: boolean
  updatedAt: number
}

type OutboxItem = JournalEncryptedMutation & {
  localFingerprint: string | null
  state: 'pending' | 'inflight' | 'retry' | 'conflict'
  attemptCount: number
  leaseId: string | null
  leaseExpiresAt: number | null
  error: string | null
  createdAt: number
  updatedAt: number
}

type MetaRecord = {
  key: 'cursor' | 'flight' | 'bootstrap'
  value: string | FlightMarker | boolean | null
}

type FlightMarker = {
  leaseId: string
  opIds: string[]
  startedAt: number
}

type ConflictRecord = {
  id: string
  entityId: string
  error: string
  localEntry: JournalEntry | null
  remote: JournalEncryptedChange | null
  candidate: JournalEncryptedMutation | null
  createdAt: number
}

type MaterializedChange = {
  change: JournalEncryptedChange
  entry: JournalEntry | null
  fingerprint: string | null
}

type LocalEncryptedObject = {
  objectKey: string
  ciphertext: ArrayBuffer
  manifest: JournalEncryptedObject
  createdAt: number
}

type PreparedMutation = {
  mutation: JournalEncryptedMutation
  objectPayloads: LocalEncryptedObject[]
}

const DATABASE_NAME = 'daylight-journal-encrypted-sync-v1'
const DATABASE_VERSION = 3
const KEY_STORE = 'keys'
const ENTITY_STORE = 'entities'
const OUTBOX_STORE = 'outbox'
const META_STORE = 'meta'
const CONFLICT_STORE = 'conflicts'
const ARCHIVE_STORE = 'archives'
const OBJECT_PAYLOAD_STORE = 'object-payloads'
const ROOT_KEY_AAD_PREFIX = 'daylight-journal-root-key-v1'
const LEASE_MS = 45_000
const MAX_MUTATIONS = 25
const MAX_PAGES = 100
const MAX_CHANGES = 100
const MAX_CIPHERTEXT_CHARS = 900_000
const MAX_SAFE_CURSOR = Number.MAX_SAFE_INTEGER
const MAX_COVER_DATA_URL_CHARS = 6 * 1024 * 1024
const MAX_ENCRYPTED_OBJECT_BYTES = 8 * 1024 * 1024
const APPROVAL_REQUEST_TTL_MS = 10 * 60 * 1_000
const APPROVAL_CLOCK_SKEW_MS = 60_000
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/

let databasePromise: Promise<IDBDatabase> | null = null
let activeSync: Promise<{ entries: JournalEntries; uploaded: number; downloaded: number; conflicts: number }> | null = null
let activeApprovalAcceptance: Promise<void> | null = null

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer
}

function base64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid base64url value')
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (base64Url(decoded) !== value) throw new Error('Non-canonical base64url value')
  return decoded
}

function randomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length)
  crypto.getRandomValues(value)
  return value
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', asArrayBuffer(utf8(value)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', asArrayBuffer(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function parseJournalDeviceId(token: string): string | null {
  const match = /^dj1\.([A-Za-z0-9][A-Za-z0-9_-]{2,127})\.[A-Za-z0-9_-]{32,}$/.exec(token)
  return match?.[1] ?? null
}

function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value)
}

function isExactBase64UrlBytes(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string') return false
  try {
    return decodeBase64Url(value).byteLength === bytes
  } catch {
    return false
  }
}

function normalizeAgreementPublicJwk(value: unknown): JsonWebKey | null {
  if (!isRecord(value) || value.kty !== 'EC' || value.crv !== 'P-256' ||
    !isExactBase64UrlBytes(value.x, 32) || !isExactBase64UrlBytes(value.y, 32) ||
    value.d !== undefined) return null
  return {
    kty: 'EC',
    crv: 'P-256',
    x: value.x,
    y: value.y,
    ext: true,
  }
}

async function agreementPublicKeyFingerprint(value: unknown): Promise<string> {
  const normalized = normalizeAgreementPublicJwk(value)
  if (!normalized) throw new Error('Invalid Journal device agreement public key')
  return sha256(stableJson(normalized))
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isRevision(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function isCursor(value: unknown): value is string {
  if (typeof value !== 'string' || !/^c[0-9a-z]+$/.test(value) || value.length > 12) return false
  const parsed = Number.parseInt(value.slice(1), 36)
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_SAFE_CURSOR
}

function isBase64Url(value: unknown, maximum = MAX_CIPHERTEXT_CHARS): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    /^[A-Za-z0-9_-]+$/.test(value)
}

function isNonce(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(value)) return false
  try {
    return decodeBase64Url(value).byteLength === 12
  } catch {
    return false
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isSyncOperation(value: unknown): value is SyncOperation {
  return value === 'upsert' || value === 'delete'
}

function isEncryptedObject(value: unknown, keyVersion: number): value is JournalEncryptedObject {
  if (!isRecord(value)) return false
  return typeof value.objectKey === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/.test(value.objectKey) &&
    !value.objectKey.includes('..') && isSha256(value.ciphertextSha256) &&
    isRevision(value.ciphertextBytes, 1) && value.ciphertextBytes <= MAX_ENCRYPTED_OBJECT_BYTES &&
    isNonce(value.nonce) && isSha256(value.aadHash) && value.keyVersion === keyVersion
}

function hasValidJournalObjects(
  objects: JournalEncryptedObject[],
  entityId: string,
  operationId: string,
): boolean {
  return objects.length <= 1 && (objects.length === 0 ||
    objects[0].objectKey === `journal_entry/${entityId}/${operationId}/cover`)
}

function isMutation(value: unknown): value is JournalEncryptedMutation {
  if (!isRecord(value) || !isUuid(value.opId) || value.entityType !== 'journal_entry' ||
    typeof value.entityId !== 'string' || !isDate(value.entityId) ||
    !isRevision(value.baseRevision) || !isSyncOperation(value.operation) ||
    !isRevision(value.keyVersion, 1) || !isSha256(value.aadHash) || !Array.isArray(value.objects) ||
    value.objects.length > 1 || !value.objects.every((item) => isEncryptedObject(item, value.keyVersion as number)) ||
    !hasValidJournalObjects(value.objects as JournalEncryptedObject[], value.entityId as string, value.opId as string)) {
    return false
  }
  return value.operation === 'delete'
    ? value.ciphertext === null && value.nonce === null && value.objects.length === 0
    : isBase64Url(value.ciphertext) && isNonce(value.nonce)
}

function isChange(value: unknown): value is JournalEncryptedChange {
  if (!isRecord(value) || value.entityType !== 'journal_entry' || typeof value.entityId !== 'string' ||
    !isDate(value.entityId) || !isRevision(value.revision, 1) || !isSyncOperation(value.operation) ||
    !isRevision(value.keyVersion, 1) || !isSha256(value.aadHash) || !Array.isArray(value.objects) ||
    value.objects.length > 1 || !value.objects.every((item) => isEncryptedObject(item, value.keyVersion as number)) ||
    typeof value.changedAt !== 'string' || !Number.isFinite(Date.parse(value.changedAt)) ||
    typeof value.originDeviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(value.originDeviceId) ||
    !isUuid(value.operationId) ||
    !hasValidJournalObjects(value.objects as JournalEncryptedObject[], value.entityId as string, value.operationId as string)) return false
  return value.operation === 'delete'
    ? value.ciphertext === null && value.nonce === null && value.objects.length === 0
    : isBase64Url(value.ciphertext) && isNonce(value.nonce)
}

function isAcknowledgement(value: unknown): value is JournalAcknowledgement {
  return isRecord(value) && value.outcome === 'acknowledged' && isUuid(value.opId) &&
    value.entityType === 'journal_entry' && typeof value.entityId === 'string' && isDate(value.entityId) &&
    isSyncOperation(value.operation) && isRevision(value.revision, 1) &&
    (value.replayed === undefined || typeof value.replayed === 'boolean')
}

function isConflict(value: unknown): value is JournalConflict {
  return isRecord(value) && value.outcome === 'conflict' && isUuid(value.opId) &&
    value.entityType === 'journal_entry' && typeof value.entityId === 'string' && isDate(value.entityId) &&
    isSyncOperation(value.operation) && typeof value.error === 'string' &&
    value.error.length > 0 && value.error.length <= 128 &&
    (value.retryable === undefined || typeof value.retryable === 'boolean') &&
    (value.current === null || isRecord(value.current)) &&
    (value.candidate === null || isMutation(value.candidate))
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function mutationAad(input: {
  entityId: string
  operation: SyncOperation
  keyVersion: number
  revision: number
}): JsonRecord {
  return {
    envelopeVersion: JOURNAL_SYNC_ENVELOPE_VERSION,
    entityId: input.entityId,
    entityType: 'journal_entry',
    keyVersion: input.keyVersion,
    operation: input.operation,
    product: 'journal',
    revision: input.revision,
  }
}

function objectAad(input: {
  entityId: string
  operation: SyncOperation
  keyVersion: number
  revision: number
  objectKey: string
}): JsonRecord {
  return { ...mutationAad(input), objectKey: input.objectKey }
}

async function aadHash(input: {
  entityId: string
  operation: SyncOperation
  keyVersion: number
  revision: number
}): Promise<string> {
  return sha256(stableJson(mutationAad(input)))
}

async function encryptJson(
  key: CryptoKey,
  value: unknown,
  aad: JsonRecord,
): Promise<{ ciphertext: string; nonce: string }> {
  const nonce = randomBytes(12)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(utf8(stableJson(aad))) },
    key,
    asArrayBuffer(utf8(JSON.stringify(value))),
  )
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), nonce: base64Url(nonce) }
}

async function decryptJson(
  key: CryptoKey,
  ciphertext: string,
  nonce: string,
  aad: JsonRecord,
): Promise<unknown> {
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: asArrayBuffer(decodeBase64Url(nonce)),
      additionalData: asArrayBuffer(utf8(stableJson(aad))),
    },
    key,
    asArrayBuffer(decodeBase64Url(ciphertext)),
  )
  return JSON.parse(new TextDecoder().decode(plain))
}

async function encryptBytes(
  key: CryptoKey,
  value: Uint8Array,
  aad: JsonRecord,
): Promise<{ ciphertext: ArrayBuffer; nonce: string }> {
  const nonce = randomBytes(12)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(utf8(stableJson(aad))) },
    key,
    asArrayBuffer(value),
  )
  return { ciphertext, nonce: base64Url(nonce) }
}

async function decryptBytes(
  key: CryptoKey,
  ciphertext: ArrayBuffer,
  nonce: string,
  aad: JsonRecord,
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: asArrayBuffer(decodeBase64Url(nonce)),
      additionalData: asArrayBuffer(utf8(stableJson(aad))),
    },
    key,
    ciphertext,
  )
}

async function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  if (typeof indexedDB === 'undefined') throw new Error('Encrypted sync storage is unavailable')
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onerror = () => reject(request.error ?? new Error('Encrypted sync storage could not open'))
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(KEY_STORE)) database.createObjectStore(KEY_STORE, { keyPath: 'key' })
      if (!database.objectStoreNames.contains(ENTITY_STORE)) database.createObjectStore(ENTITY_STORE, { keyPath: 'entityId' })
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) database.createObjectStore(OUTBOX_STORE, { keyPath: 'opId' })
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: 'key' })
      if (!database.objectStoreNames.contains(CONFLICT_STORE)) database.createObjectStore(CONFLICT_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(ARCHIVE_STORE)) database.createObjectStore(ARCHIVE_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(OBJECT_PAYLOAD_STORE)) database.createObjectStore(OBJECT_PAYLOAD_STORE, { keyPath: 'objectKey' })
    }
    request.onsuccess = () => resolve(request.result)
  })
  return databasePromise
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted'))
  })
}

async function readIdentity(): Promise<SyncIdentity | null> {
  const database = await openDatabase()
  const transaction = database.transaction(KEY_STORE, 'readonly')
  const value = await requestResult(transaction.objectStore(KEY_STORE).get('identity-v1')) as SyncIdentity | undefined
  await transactionDone(transaction)
  if (!value) return null
  return {
    ...value,
    wrappedRootKey: value.wrappedRootKey ?? null,
    rootFingerprint: value.rootFingerprint ?? null,
    approvalRequest: value.approvalRequest ?? null,
  }
}

async function writeIdentity(identity: SyncIdentity): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(KEY_STORE, 'readwrite')
  transaction.objectStore(KEY_STORE).put(identity)
  await transactionDone(transaction)
}

async function createIdentity(deviceId: string): Promise<SyncIdentity> {
  const deviceWrappingKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const temporaryPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )
  const privateJwk = await crypto.subtle.exportKey('jwk', temporaryPair.privateKey)
  const agreementPrivateKey = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  )
  const publicAgreementJwk = await crypto.subtle.exportKey('jwk', temporaryPair.publicKey)
  const identity: SyncIdentity = {
    key: 'identity-v1',
    deviceId,
    deviceWrappingKey,
    agreementPrivateKey,
    agreementPublicKey: temporaryPair.publicKey,
    publicAgreementJwk,
    wrappedRootKey: null,
    rootFingerprint: null,
    approvalRequest: null,
  }
  const database = await openDatabase()
  const transaction = database.transaction(KEY_STORE, 'readwrite')
  transaction.objectStore(KEY_STORE).put(identity)
  await transactionDone(transaction)
  return identity
}

async function ensureIdentity(deviceId: string): Promise<SyncIdentity> {
  const existing = await readIdentity()
  if (existing) {
    if (existing.deviceId !== deviceId) throw new Error('Encrypted sync device identity does not match this device token')
    return existing
  }
  return createIdentity(deviceId)
}

async function encryptRaw(
  key: CryptoKey,
  plain: Uint8Array,
  aad: JsonRecord,
): Promise<WrappedRootKey> {
  const nonce = randomBytes(12)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(utf8(stableJson(aad))) },
    key,
    asArrayBuffer(plain),
  )
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), nonce: base64Url(nonce) }
}

async function decryptRaw(
  key: CryptoKey,
  wrapped: WrappedRootKey,
  aad: JsonRecord,
): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: asArrayBuffer(decodeBase64Url(wrapped.nonce)),
      additionalData: asArrayBuffer(utf8(stableJson(aad))),
    },
    key,
    asArrayBuffer(decodeBase64Url(wrapped.ciphertext)),
  )
  return new Uint8Array(plain)
}

async function rootKey(identity: SyncIdentity): Promise<CryptoKey> {
  if (!identity.wrappedRootKey) throw new Error('Journal sync root key is not initialized')
  const raw = await decryptRaw(
    identity.deviceWrappingKey,
    identity.wrappedRootKey,
    { scope: ROOT_KEY_AAD_PREFIX, deviceId: identity.deviceId },
  )
  return crypto.subtle.importKey('raw', asArrayBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function rootKeyBytes(identity: SyncIdentity): Promise<Uint8Array> {
  if (!identity.wrappedRootKey) throw new Error('Journal sync root key is not initialized')
  return decryptRaw(
    identity.deviceWrappingKey,
    identity.wrappedRootKey,
    { scope: ROOT_KEY_AAD_PREFIX, deviceId: identity.deviceId },
  )
}

async function replaceRootKey(identity: SyncIdentity, raw: Uint8Array): Promise<void> {
  if (raw.byteLength !== 32) throw new Error('Journal root key must contain 32 bytes')
  const nextFingerprint = await sha256Bytes(raw)
  let previousFingerprint = identity.rootFingerprint
  if (!previousFingerprint && identity.wrappedRootKey) {
    try {
      previousFingerprint = await sha256Bytes(await rootKeyBytes(identity))
    } catch {
      previousFingerprint = null
    }
  }
  const firstRoot = identity.wrappedRootKey === null
  const changedRoot = !firstRoot && previousFingerprint !== nextFingerprint
  const next: SyncIdentity = {
    ...identity,
    wrappedRootKey: await encryptRaw(
      identity.deviceWrappingKey,
      raw,
      { scope: ROOT_KEY_AAD_PREFIX, deviceId: identity.deviceId },
    ),
    rootFingerprint: nextFingerprint,
    approvalRequest: null,
  }
  const database = await openDatabase()
  const stores = changedRoot
    ? [KEY_STORE, ENTITY_STORE, OUTBOX_STORE, META_STORE, CONFLICT_STORE, ARCHIVE_STORE, OBJECT_PAYLOAD_STORE]
    : [KEY_STORE, META_STORE]
  const transaction = database.transaction(stores, 'readwrite')
  if (changedRoot) {
    const entityStore = transaction.objectStore(ENTITY_STORE)
    const outboxStore = transaction.objectStore(OUTBOX_STORE)
    const metaStore = transaction.objectStore(META_STORE)
    const conflictStore = transaction.objectStore(CONFLICT_STORE)
    const objectPayloadStore = transaction.objectStore(OBJECT_PAYLOAD_STORE)
    const entityRequest = entityStore.getAll()
    const outboxRequest = outboxStore.getAll()
    const metaRequest = metaStore.getAll()
    const conflictRequest = conflictStore.getAll()
    const objectPayloadRequest = objectPayloadStore.getAll()
    const [entities, outbox, meta, conflicts, objectPayloads] = await Promise.all([
      requestResult(entityRequest),
      requestResult(outboxRequest),
      requestResult(metaRequest),
      requestResult(conflictRequest),
      requestResult(objectPayloadRequest),
    ])
    transaction.objectStore(ARCHIVE_STORE).put({
      id: `root-change-${Date.now()}-${crypto.randomUUID()}`,
      reason: 'root_fingerprint_changed',
      previousFingerprint,
      nextFingerprint,
      previousWrappedRootKey: identity.wrappedRootKey,
      entities,
      outbox,
      meta,
      conflicts,
      objectPayloads,
      createdAt: Date.now(),
    })
    entityStore.clear()
    outboxStore.clear()
    metaStore.clear()
    conflictStore.clear()
    objectPayloadStore.clear()
  }
  transaction.objectStore(KEY_STORE).put(next)
  if (firstRoot || changedRoot) {
    transaction.objectStore(META_STORE).put({ key: 'bootstrap', value: false } satisfies MetaRecord)
  }
  await transactionDone(transaction)
}

/** Report whether a configured device has received the shared root key. */
export async function journalSyncRootReady(deviceToken: string): Promise<boolean> {
  const deviceId = parseJournalDeviceId(deviceToken)
  if (!deviceId) return false
  const identity = await readIdentity()
  return identity?.deviceId === deviceId && identity.wrappedRootKey !== null
}

/** Explicit first-device action. Never overwrites an existing root key. */
export async function initializeJournalSyncRoot(deviceToken: string): Promise<boolean> {
  const deviceId = parseJournalDeviceId(deviceToken)
  if (!deviceId) throw new Error('Sync is not paired with a Journal device token')
  const identity = await ensureIdentity(deviceId)
  if (identity.wrappedRootKey) return false
  await replaceRootKey(identity, randomBytes(32))
  return true
}

function shouldSynchronize(entry: JournalEntry): boolean {
  return Boolean(entry.title.trim() || entry.content.trim() || entry.coverImage)
}

async function entryFingerprint(entry: JournalEntry): Promise<string> {
  return sha256(stableJson(entry))
}

async function readLocalState(): Promise<{
  entities: LocalEntity[]
  outbox: OutboxItem[]
  cursor: string | null
  bootstrapComplete: boolean
}> {
  const database = await openDatabase()
  const transaction = database.transaction([ENTITY_STORE, OUTBOX_STORE, META_STORE], 'readonly')
  const entityRequest = transaction.objectStore(ENTITY_STORE).getAll()
  const outboxRequest = transaction.objectStore(OUTBOX_STORE).getAll()
  const cursorRequest = transaction.objectStore(META_STORE).get('cursor')
  const bootstrapRequest = transaction.objectStore(META_STORE).get('bootstrap')
  const [entities, outbox, cursor, bootstrap] = await Promise.all([
    requestResult(entityRequest) as Promise<LocalEntity[]>,
    requestResult(outboxRequest) as Promise<OutboxItem[]>,
    requestResult(cursorRequest) as Promise<MetaRecord | undefined>,
    requestResult(bootstrapRequest) as Promise<MetaRecord | undefined>,
  ])
  await transactionDone(transaction)
  return {
    entities,
    outbox,
    cursor: typeof cursor?.value === 'string' ? cursor.value : null,
    bootstrapComplete: bootstrap?.value === true,
  }
}

async function markBootstrapComplete(): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(META_STORE, 'readwrite')
  transaction.objectStore(META_STORE).put({ key: 'bootstrap', value: true } satisfies MetaRecord)
  await transactionDone(transaction)
}

async function createMutation(
  key: CryptoKey,
  entityId: string,
  baseRevision: number,
  entry: JournalEntry | null,
): Promise<PreparedMutation> {
  const operation: SyncOperation = entry ? 'upsert' : 'delete'
  const revision = baseRevision + 1
  const keyVersion = 1
  const aad = mutationAad({ entityId, operation, keyVersion, revision })
  const base: JournalEncryptedMutation = {
    opId: crypto.randomUUID(),
    entityType: 'journal_entry',
    entityId,
    baseRevision,
    operation,
    keyVersion,
    ciphertext: null,
    nonce: null,
    aadHash: await sha256(stableJson(aad)),
    objects: [],
  }
  if (!entry) return { mutation: base, objectPayloads: [] }

  const entityEntry: JournalEntry = { ...entry }
  delete entityEntry.coverImage
  const encrypted = await encryptJson(key, entityEntry, aad)
  const mutation: JournalEncryptedMutation = {
    ...base,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
  }
  if (!entry.coverImage) return { mutation, objectPayloads: [] }
  if (entry.coverImage.length > MAX_COVER_DATA_URL_CHARS ||
    !/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(entry.coverImage)) {
    throw new Error('Journal cover image is not a supported bounded data URL')
  }

  const objectKey = `journal_entry/${entityId}/${base.opId}/cover`
  const attachmentAad = objectAad({ entityId, operation, keyVersion, revision, objectKey })
  const encryptedObject = await encryptBytes(key, utf8(entry.coverImage), attachmentAad)
  const objectCiphertext = new Uint8Array(encryptedObject.ciphertext)
  const manifest: JournalEncryptedObject = {
    objectKey,
    ciphertextSha256: await sha256Bytes(objectCiphertext),
    ciphertextBytes: objectCiphertext.byteLength,
    nonce: encryptedObject.nonce,
    aadHash: await sha256(stableJson(attachmentAad)),
    keyVersion,
  }
  mutation.objects = [manifest]
  return {
    mutation,
    objectPayloads: [{
      objectKey,
      ciphertext: asArrayBuffer(objectCiphertext),
      manifest,
      createdAt: Date.now(),
    }],
  }
}

async function stageLocalEntries(entries: JournalEntries, key: CryptoKey): Promise<void> {
  const state = await readLocalState()
  const previous = new Map(state.entities.map((entity) => [entity.entityId, entity]))
  const activeByEntity = new Map<string, OutboxItem>()
  for (const item of state.outbox) {
    const current = activeByEntity.get(item.entityId)
    if (!current || current.createdAt <= item.createdAt) activeByEntity.set(item.entityId, item)
  }
  const next = new Map<string, LocalEntity>()
  const pendingDeletes = new Set<string>()
  const mutations: OutboxItem[] = []
  const objectPayloads: LocalEncryptedObject[] = []

  for (const entry of Object.values(entries)) {
    const existing = previous.get(entry.date)
    const active = activeByEntity.get(entry.date)
    if (!shouldSynchronize(entry)) {
      if (!existing || (existing.deleted && existing.confirmedFingerprint === null)) continue
      next.set(entry.date, {
        ...existing,
        entry: null,
        localFingerprint: null,
        deleted: true,
        updatedAt: Date.now(),
      })
      if (active?.operation === 'delete' && active.localFingerprint === null) continue
      if (active?.state === 'inflight' || active?.state === 'conflict') continue
      if (active?.state === 'pending' || active?.state === 'retry') pendingDeletes.add(active.opId)
      const prepared = await createMutation(key, entry.date, existing.confirmedRevision, null)
      mutations.push({
        ...prepared.mutation,
        localFingerprint: null,
        state: 'pending',
        attemptCount: 0,
        leaseId: null,
        leaseExpiresAt: null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      objectPayloads.push(...prepared.objectPayloads)
      continue
    }
    const fingerprint = await entryFingerprint(entry)
    const local: LocalEntity = {
      entityId: entry.date,
      entry,
      localFingerprint: fingerprint,
      confirmedRevision: existing?.confirmedRevision ?? 0,
      confirmedFingerprint: existing?.confirmedFingerprint ?? null,
      deleted: false,
      updatedAt: Date.now(),
    }
    next.set(entry.date, local)
    if (fingerprint === existing?.confirmedFingerprint) continue
    if (active?.operation === 'upsert' && active.localFingerprint === fingerprint) continue
    if (active?.state === 'inflight' || active?.state === 'conflict') continue
    if (active?.state === 'pending' || active?.state === 'retry') pendingDeletes.add(active.opId)
    const prepared = await createMutation(key, entry.date, local.confirmedRevision, entry)
    mutations.push({
      ...prepared.mutation,
      localFingerprint: fingerprint,
      state: 'pending',
      attemptCount: 0,
      leaseId: null,
      leaseExpiresAt: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    objectPayloads.push(...prepared.objectPayloads)
  }

  const database = await openDatabase()
  const transaction = database.transaction([ENTITY_STORE, OUTBOX_STORE, META_STORE, OBJECT_PAYLOAD_STORE], 'readwrite')
  const entityStore = transaction.objectStore(ENTITY_STORE)
  const outboxStore = transaction.objectStore(OUTBOX_STORE)
  const objectPayloadStore = transaction.objectStore(OBJECT_PAYLOAD_STORE)
  for (const value of next.values()) entityStore.put(value)
  for (const id of pendingDeletes) {
    const pending = state.outbox.find((item) => item.opId === id)
    for (const object of pending?.objects ?? []) objectPayloadStore.delete(object.objectKey)
    outboxStore.delete(id)
  }
  for (const mutation of mutations) outboxStore.put(mutation)
  for (const objectPayload of objectPayloads) objectPayloadStore.put(objectPayload)
  transaction.objectStore(META_STORE).put({ key: 'flight', value: null } satisfies MetaRecord)
  await transactionDone(transaction)
}

async function claimOutbox(now = Date.now()): Promise<{ leaseId: string; items: OutboxItem[] }> {
  const database = await openDatabase()
  const transaction = database.transaction([OUTBOX_STORE, META_STORE], 'readwrite')
  const outbox = transaction.objectStore(OUTBOX_STORE)
  const all = await requestResult(outbox.getAll()) as OutboxItem[]
  const leaseId = crypto.randomUUID()
  const items = all
    .filter((item) =>
      item.state === 'pending' || item.state === 'retry' ||
        (item.state === 'inflight' && (item.leaseExpiresAt ?? 0) <= now),
    )
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(0, MAX_MUTATIONS)
    .map((item) => ({
      ...item,
      state: 'inflight' as const,
      leaseId,
      leaseExpiresAt: now + LEASE_MS,
      updatedAt: now,
    }))
  for (const item of items) outbox.put(item)
  transaction.objectStore(META_STORE).put({
    key: 'flight',
    value: { leaseId, opIds: items.map((item) => item.opId), startedAt: now },
  } satisfies MetaRecord)
  await transactionDone(transaction)
  return { leaseId, items }
}

async function retryLease(leaseId: string, error: string): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction([OUTBOX_STORE, META_STORE], 'readwrite')
  const outbox = transaction.objectStore(OUTBOX_STORE)
  const all = await requestResult(outbox.getAll()) as OutboxItem[]
  for (const item of all) {
    if (item.leaseId !== leaseId || item.state !== 'inflight') continue
    outbox.put({
      ...item,
      state: 'retry',
      attemptCount: item.attemptCount + 1,
      leaseId: null,
      leaseExpiresAt: null,
      error,
      updatedAt: Date.now(),
    })
  }
  transaction.objectStore(META_STORE).put({ key: 'flight', value: null } satisfies MetaRecord)
  await transactionDone(transaction)
}

function parseRemoteEntry(entityId: string, value: unknown): JournalEntry {
  if (!isDate(entityId)) throw new Error('Encrypted change has an invalid journal entity id')
  const decoded = decodeJournalEntries({ [entityId]: value })
  const entry = decoded.entries[entityId]
  if (decoded.invalidRoot || decoded.invalidKeys.length || !entry) {
    throw new Error('Encrypted change does not contain a valid journal entry')
  }
  return entry
}

function sameEncryptedObject(
  left: JournalEncryptedObject,
  right: JournalEncryptedObject,
): boolean {
  return left.objectKey === right.objectKey && left.ciphertextSha256 === right.ciphertextSha256 &&
    left.ciphertextBytes === right.ciphertextBytes && left.nonce === right.nonce &&
    left.aadHash === right.aadHash && left.keyVersion === right.keyVersion
}

async function readLocalObjectPayload(manifest: JournalEncryptedObject): Promise<ArrayBuffer | null> {
  const database = await openDatabase()
  const transaction = database.transaction(OBJECT_PAYLOAD_STORE, 'readonly')
  const stored = await requestResult(
    transaction.objectStore(OBJECT_PAYLOAD_STORE).get(manifest.objectKey),
  ) as LocalEncryptedObject | undefined
  await transactionDone(transaction)
  if (!stored) return null
  if (!(stored.ciphertext instanceof ArrayBuffer) || !sameEncryptedObject(stored.manifest, manifest) ||
    stored.ciphertext.byteLength !== manifest.ciphertextBytes ||
    await sha256Bytes(new Uint8Array(stored.ciphertext)) !== manifest.ciphertextSha256) {
    throw new Error('Persisted encrypted Journal object does not match its manifest')
  }
  return stored.ciphertext.slice(0)
}

function encryptedObjectUrl(endpoint: string, objectKey: string): string {
  return `${endpoint.replace(/\/$/, '')}/sync/v2/objects/${encodeURIComponent(objectKey)}`
}

function encryptedObjectResponseMatches(
  response: Response,
  manifest: JournalEncryptedObject,
  requireMediaType = false,
): boolean {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  return (!requireMediaType || mediaType === 'application/octet-stream') &&
    response.headers.get('x-ciphertext-sha256') === manifest.ciphertextSha256 &&
    response.headers.get('x-ciphertext-bytes') === String(manifest.ciphertextBytes) &&
    response.headers.get('x-object-nonce') === manifest.nonce &&
    response.headers.get('x-object-aad-hash') === manifest.aadHash &&
    response.headers.get('x-key-version') === String(manifest.keyVersion)
}

async function uploadMutationObjects(
  endpoint: string,
  token: string,
  deviceId: string,
  items: OutboxItem[],
): Promise<void> {
  for (const item of items) {
    for (const manifest of item.objects) {
      const ciphertext = await readLocalObjectPayload(manifest)
      if (!ciphertext) throw new Error('Encrypted Journal object payload is missing from the durable outbox')
      const response = await journalBinaryFetch(encryptedObjectUrl(endpoint, manifest.objectKey), {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'X-Journal-Device-Id': deviceId,
          'X-Ciphertext-Sha256': manifest.ciphertextSha256,
          'X-Ciphertext-Bytes': String(manifest.ciphertextBytes),
          'X-Object-Nonce': manifest.nonce,
          'X-Object-Aad-Hash': manifest.aadHash,
          'X-Key-Version': String(manifest.keyVersion),
        },
        body: ciphertext,
      })
      if (![201, 204].includes(response.status)) {
        throw new Error(`Encrypted object upload failed: ${response.status}`)
      }
      if (!encryptedObjectResponseMatches(response, manifest)) {
        throw new Error('Encrypted object upload acknowledgement does not match its manifest')
      }
    }
  }
}

async function downloadEncryptedObject(
  endpoint: string,
  token: string,
  deviceId: string,
  manifest: JournalEncryptedObject,
): Promise<ArrayBuffer> {
  const local = await readLocalObjectPayload(manifest)
  if (local) return local
  const response = await journalBinaryFetch(encryptedObjectUrl(endpoint, manifest.objectKey), {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Journal-Device-Id': deviceId,
    },
  })
  if (!response.ok) throw new Error(`Encrypted object download failed: ${response.status}`)
  if (!encryptedObjectResponseMatches(response, manifest, true)) {
    throw new Error('Encrypted object download metadata does not match its manifest')
  }
  const ciphertext = await response.arrayBuffer()
  if (ciphertext.byteLength !== manifest.ciphertextBytes ||
    await sha256Bytes(new Uint8Array(ciphertext)) !== manifest.ciphertextSha256) {
    throw new Error('Downloaded encrypted Journal object does not match its manifest')
  }
  return ciphertext
}

async function materializeCoverImage(
  key: CryptoKey,
  change: JournalEncryptedChange,
  endpoint: string,
  token: string,
  deviceId: string,
): Promise<string | undefined> {
  if (change.objects.length === 0) return undefined
  if (change.objects.length !== 1) throw new Error('Journal entries support exactly one encrypted cover object')
  const manifest = change.objects[0]
  if (!manifest.objectKey.startsWith(`journal_entry/${change.entityId}/`) ||
    !manifest.objectKey.endsWith('/cover')) {
    throw new Error('Encrypted Journal object is not a cover for this entry')
  }
  const aad = objectAad({
    entityId: change.entityId,
    operation: change.operation,
    keyVersion: change.keyVersion,
    revision: change.revision,
    objectKey: manifest.objectKey,
  })
  if (await sha256(stableJson(aad)) !== manifest.aadHash) {
    throw new Error('Encrypted Journal object AAD does not match its manifest')
  }
  const ciphertext = await downloadEncryptedObject(endpoint, token, deviceId, manifest)
  const plaintext = await decryptBytes(key, ciphertext, manifest.nonce, aad)
  const coverImage = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  if (coverImage.length > MAX_COVER_DATA_URL_CHARS ||
    !/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(coverImage)) {
    throw new Error('Decrypted Journal cover object has an invalid media payload')
  }
  return coverImage
}

async function materializeChanges(
  key: CryptoKey,
  changes: JournalEncryptedChange[],
  endpoint: string,
  token: string,
  deviceId: string,
): Promise<MaterializedChange[]> {
  const result: MaterializedChange[] = []
  for (const change of changes) {
    if (change.entityType !== 'journal_entry' || !isDate(change.entityId)) {
      throw new Error('Encrypted change has an unsupported entity')
    }
    const expectedHash = await aadHash({
      entityId: change.entityId,
      operation: change.operation,
      keyVersion: change.keyVersion,
      revision: change.revision,
    })
    if (expectedHash !== change.aadHash) throw new Error('Encrypted change AAD does not match its metadata')
    if (change.operation === 'delete') {
      if (change.ciphertext !== null || change.nonce !== null || change.objects.length !== 0) {
        throw new Error('Encrypted delete change has payload material')
      }
      result.push({ change, entry: null, fingerprint: null })
      continue
    }
    if (!change.ciphertext || !change.nonce) throw new Error('Encrypted Journal upsert is missing its entity payload')
    const decrypted = await decryptJson(
      key,
      change.ciphertext,
      change.nonce,
      mutationAad({
        entityId: change.entityId,
        operation: change.operation,
        keyVersion: change.keyVersion,
        revision: change.revision,
      }),
    )
    const decodedEntry = parseRemoteEntry(change.entityId, decrypted)
    const coverImage = await materializeCoverImage(key, change, endpoint, token, deviceId)
    const entry = coverImage ? { ...decodedEntry, coverImage } : decodedEntry
    result.push({ change, entry, fingerprint: await entryFingerprint(entry) })
  }
  return result
}

function isExchangeResponse(value: unknown): value is JournalExchangeResponse {
  return isRecord(value) && value.protocolVersion === 2 && value.envelopeVersion === 1 &&
    value.product === 'journal' && Array.isArray(value.acknowledged) &&
    value.acknowledged.length <= MAX_MUTATIONS && value.acknowledged.every(isAcknowledgement) &&
    Array.isArray(value.conflicts) && value.conflicts.length <= MAX_MUTATIONS &&
    value.conflicts.every(isConflict) && Array.isArray(value.changes) && value.changes.length <= MAX_CHANGES &&
    value.changes.every(isChange) && isCursor(value.nextCursor) &&
    typeof value.hasMore === 'boolean' && typeof value.serverTime === 'string' &&
    Number.isFinite(Date.parse(value.serverTime))
}

async function applyResponse(
  response: JournalExchangeResponse,
  leaseId: string,
  materialized: MaterializedChange[],
): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(
    [ENTITY_STORE, OUTBOX_STORE, META_STORE, CONFLICT_STORE, OBJECT_PAYLOAD_STORE],
    'readwrite',
  )
  const entities = transaction.objectStore(ENTITY_STORE)
  const outbox = transaction.objectStore(OUTBOX_STORE)
  const conflicts = transaction.objectStore(CONFLICT_STORE)
  const objectPayloads = transaction.objectStore(OBJECT_PAYLOAD_STORE)
  const entityRequest = entities.getAll()
  const outboxRequest = outbox.getAll()
  const cursorRequest = transaction.objectStore(META_STORE).get('cursor')
  const [entityValues, outboxValues, currentCursor] = await Promise.all([
    requestResult(entityRequest) as Promise<LocalEntity[]>,
    requestResult(outboxRequest) as Promise<OutboxItem[]>,
    requestResult(cursorRequest) as Promise<MetaRecord | undefined>,
  ])
  const entityById = new Map(entityValues.map((entry) => [entry.entityId, entry]))
  const outboxById = new Map(outboxValues.map((entry) => [entry.opId, entry]))
  const protectedLocal = new Set<string>()
  const resultIds = new Set<string>()

  const reject = (message: string): never => {
    try { transaction.abort() } catch { /* The browser may already have aborted it. */ }
    throw new Error(message)
  }

  if (typeof currentCursor?.value === 'string' && !isCursor(currentCursor.value)) {
    reject('Stored encrypted sync cursor is invalid')
  }
  const currentCursorValue = typeof currentCursor?.value === 'string'
    ? Number.parseInt(currentCursor.value.slice(1), 36)
    : 0
  const nextCursorValue = Number.parseInt(response.nextCursor.slice(1), 36)
  if (nextCursorValue < currentCursorValue) reject('Encrypted sync cursor regressed')

  for (const acknowledgement of response.acknowledged) {
    const item = outboxById.get(acknowledgement.opId) ??
      reject('Encrypted acknowledgement has no matching local mutation')
    if (item.leaseId !== leaseId || resultIds.has(acknowledgement.opId) ||
      acknowledgement.entityId !== item.entityId || acknowledgement.entityType !== item.entityType ||
      acknowledgement.operation !== item.operation || acknowledgement.revision !== item.baseRevision + 1) {
      reject('Encrypted acknowledgement does not match its leased mutation')
    }
    resultIds.add(acknowledgement.opId)
    const entity = entityById.get(item.entityId)
    if (entity) {
      if (entity.localFingerprint !== item.localFingerprint) protectedLocal.add(item.entityId)
      entityById.set(item.entityId, {
        ...entity,
        confirmedRevision: acknowledgement.revision,
        confirmedFingerprint: item.localFingerprint,
        updatedAt: Date.now(),
      })
    }
    for (const object of item.objects) objectPayloads.delete(object.objectKey)
    outbox.delete(item.opId)
    outboxById.delete(item.opId)
  }

  for (const conflict of response.conflicts) {
    const item = outboxById.get(conflict.opId) ??
      reject('Encrypted conflict has no matching local mutation')
    if (item.leaseId !== leaseId || resultIds.has(conflict.opId) ||
      conflict.entityId !== item.entityId || conflict.entityType !== item.entityType ||
      conflict.operation !== item.operation) {
      reject('Encrypted conflict does not match its leased mutation')
    }
    resultIds.add(conflict.opId)
    const conflicted: OutboxItem = {
      ...item,
      state: 'conflict',
      leaseId: null,
      leaseExpiresAt: null,
      error: conflict.error,
      updatedAt: Date.now(),
    }
    outbox.put(conflicted)
    outboxById.set(conflict.opId, conflicted)
    const entity = entityById.get(item.entityId)
    conflicts.put({
      id: conflict.opId,
      entityId: item.entityId,
      error: conflict.error,
      localEntry: entity?.entry ?? null,
      remote: conflict.current,
      candidate: conflict.candidate,
      createdAt: Date.now(),
    } satisfies ConflictRecord)
  }

  const unresolvedLease = outboxValues.find((item) =>
    item.leaseId === leaseId && item.state === 'inflight' && !resultIds.has(item.opId),
  )
  if (unresolvedLease) reject('Encrypted response omitted a leased mutation result')

  for (const materializedChange of materialized) {
    const { change, entry, fingerprint } = materializedChange
    const entity = entityById.get(change.entityId)
    const active = [...outboxById.values()].find((item) =>
      item.entityId === change.entityId && item.state !== 'conflict',
    )
    if (protectedLocal.has(change.entityId) || active) {
      conflicts.put({
        id: `remote-${change.operationId}`,
        entityId: change.entityId,
        error: active ? 'REMOTE_CHANGE_WHILE_LOCAL_OUTBOX_PENDING' : 'LOCAL_CHANGE_AFTER_ACK',
        localEntry: entity?.entry ?? null,
        remote: change,
        candidate: active ?? null,
        createdAt: Date.now(),
      } satisfies ConflictRecord)
      continue
    }
    if (entity && change.revision < entity.confirmedRevision) {
      reject('Encrypted change revision regressed')
    }
    if (entity && change.revision === entity.confirmedRevision &&
      entity.confirmedFingerprint !== fingerprint) {
      reject('Encrypted change reused a revision with different content')
    }
    entityById.set(change.entityId, {
      entityId: change.entityId,
      entry,
      localFingerprint: fingerprint,
      confirmedRevision: change.revision,
      confirmedFingerprint: fingerprint,
      deleted: change.operation === 'delete',
      updatedAt: Date.now(),
    })
  }

  for (const entity of entityById.values()) entities.put(entity)
  transaction.objectStore(META_STORE).put({ key: 'cursor', value: response.nextCursor } satisfies MetaRecord)
  transaction.objectStore(META_STORE).put({ key: 'flight', value: null } satisfies MetaRecord)
  await transactionDone(transaction)
}

async function syncedEntries(): Promise<JournalEntries> {
  const database = await openDatabase()
  const transaction = database.transaction(ENTITY_STORE, 'readonly')
  const entities = await requestResult(transaction.objectStore(ENTITY_STORE).getAll()) as LocalEntity[]
  await transactionDone(transaction)
  return Object.fromEntries(
    entities.flatMap((entity) => entity.deleted || !entity.entry ? [] : [[entity.entityId, entity.entry]]),
  )
}

async function postExchange(
  endpoint: string,
  token: string,
  deviceId: string,
  cursor: string | null,
  items: OutboxItem[],
): Promise<JournalExchangeResponse> {
  const response = await journalFetch(`${endpoint.replace(/\/$/, '')}/sync/v2/exchange`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: JOURNAL_SYNC_PROTOCOL_VERSION,
      envelopeVersion: JOURNAL_SYNC_ENVELOPE_VERSION,
      product: 'journal',
      deviceId,
      cursor,
      mutations: items.map(({ localFingerprint: _localFingerprint, state: _state, attemptCount: _attemptCount, leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, error: _error, createdAt: _createdAt, updatedAt: _updatedAt, ...mutation }) => mutation),
    }),
  })
  if (!response.ok) throw new Error(`Sync failed: ${response.status}`)
  const body: unknown = await response.json()
  if (!isExchangeResponse(body)) throw new Error('Sync response is not a SyncEnvelopeV1 response')
  return body
}

async function runEncryptedJournalSync(input: {
  endpoint: string
  deviceToken: string
  entries: JournalEntries
}): Promise<{ entries: JournalEntries; uploaded: number; downloaded: number; conflicts: number }> {
  const deviceId = parseJournalDeviceId(input.deviceToken)
  if (!deviceId) throw new Error('Sync is not paired with a Journal device token')
  const identity = await ensureIdentity(deviceId)
  const key = await rootKey(identity)
  let uploaded = 0
  let downloaded = 0
  let conflicts = 0
  let state = await readLocalState()
  if (!state.bootstrapComplete) {
    let completed = false
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await postExchange(input.endpoint, input.deviceToken, deviceId, state.cursor, [])
      const materialized = await materializeChanges(
        key,
        response.changes,
        input.endpoint,
        input.deviceToken,
        deviceId,
      )
      await applyResponse(response, `bootstrap-${crypto.randomUUID()}`, materialized)
      downloaded += materialized.length
      conflicts += response.conflicts.length
      if (!response.hasMore) {
        await markBootstrapComplete()
        completed = true
        break
      }
      state = await readLocalState()
    }
    if (!completed) throw new Error('Sync bootstrap pagination did not converge')
  }
  await stageLocalEntries(input.entries, key)
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const state = await readLocalState()
    const claimed = await claimOutbox()
    let response: JournalExchangeResponse
    try {
      await uploadMutationObjects(input.endpoint, input.deviceToken, deviceId, claimed.items)
      response = await postExchange(input.endpoint, input.deviceToken, deviceId, state.cursor, claimed.items)
    } catch (error) {
      await retryLease(claimed.leaseId, error instanceof Error ? error.message : 'network')
      throw error
    }
    const materialized = await materializeChanges(
      key,
      response.changes,
      input.endpoint,
      input.deviceToken,
      deviceId,
    )
    await applyResponse(response, claimed.leaseId, materialized)
    uploaded += response.acknowledged.length
    downloaded += materialized.length
    conflicts += response.conflicts.length
    if (!response.hasMore && claimed.items.length === 0) {
      return { entries: await syncedEntries(), uploaded, downloaded, conflicts }
    }
  }
  throw new Error('Sync pagination did not converge')
}

/** Encrypt, exchange, materialize, and ACK Journal state without sending business plaintext to the cloud. */
export async function syncEncryptedJournal(input: {
  endpoint: string
  deviceToken: string
  entries: JournalEntries
}): Promise<{ entries: JournalEntries; uploaded: number; downloaded: number; conflicts: number }> {
  if (activeSync) return activeSync
  activeSync = runEncryptedJournalSync(input)
  try {
    return await activeSync
  } finally {
    activeSync = null
  }
}

async function recoveryKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  if (secret.length < 16) throw new Error('Recovery secret must contain at least 16 characters')
  const material = await crypto.subtle.importKey('raw', asArrayBuffer(utf8(secret)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: asArrayBuffer(salt), iterations: 310_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function approvalContext(input: {
  fromDeviceId: string
  toDeviceId: string
  requestNonce: string
  targetPublicKeySha256: string
}): JsonRecord {
  return {
    scope: 'daylight-journal-device-approval-v2',
    fromDeviceId: input.fromDeviceId,
    toDeviceId: input.toDeviceId,
    requestNonce: input.requestNonce,
    targetPublicKeySha256: input.targetPublicKeySha256,
  }
}

function approvalAad(input: {
  fromDeviceId: string
  toDeviceId: string
  requestNonce: string
  targetPublicKeySha256: string
  issuedAt: number
  expiresAt: number
}): JsonRecord {
  return {
    ...approvalContext(input),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  }
}

async function approvalTransportKey(
  sharedSecret: ArrayBuffer,
  requestNonce: string,
  context: JsonRecord,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: asArrayBuffer(decodeBase64Url(requestNonce)),
      info: asArrayBuffer(utf8(stableJson(context))),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function parseApprovalRequest(value: unknown, now = Date.now()): {
  deviceId: string
  publicKey: JsonWebKey
  requestNonce: string
  createdAt: number
  expiresAt: number
} {
  if (!isRecord(value) || value.version !== 2 || !isDeviceId(value.deviceId) ||
    !isExactBase64UrlBytes(value.requestNonce, 32) || !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.expiresAt)) {
    throw new Error('Invalid Journal device approval request')
  }
  const createdAt = value.createdAt as number
  const expiresAt = value.expiresAt as number
  if (createdAt > now + APPROVAL_CLOCK_SKEW_MS || expiresAt <= now ||
    expiresAt <= createdAt || expiresAt - createdAt > APPROVAL_REQUEST_TTL_MS) {
    throw new Error('Journal device approval request is expired or has an invalid lifetime')
  }
  const publicKey = normalizeAgreementPublicJwk(value.publicKey)
  if (!publicKey) throw new Error('Invalid Journal device approval public key')
  return {
    deviceId: value.deviceId,
    publicKey,
    requestNonce: value.requestNonce,
    createdAt,
    expiresAt,
  }
}

/** Export a recovery package. It contains an encrypted root key, never plaintext credentials or entries. */
export async function createJournalRecoveryPackage(secret: string): Promise<JsonRecord> {
  const identity = await readIdentity()
  if (!identity) throw new Error('No Journal encrypted identity exists on this device')
  const salt = randomBytes(16)
  const key = await recoveryKey(secret, salt)
  const wrapped = await encryptRaw(
    key,
    await rootKeyBytes(identity),
    { scope: 'daylight-journal-recovery-v1', deviceId: identity.deviceId },
  )
  return {
    version: 1,
    deviceId: identity.deviceId,
    salt: base64Url(salt),
    ...wrapped,
  }
}

/** Import a recovery package into a newly paired device after its device token is configured. */
export async function importJournalRecoveryPackage(
  deviceToken: string,
  secret: string,
  value: unknown,
): Promise<void> {
  const deviceId = parseJournalDeviceId(deviceToken)
  if (!deviceId || !isRecord(value) || value.version !== 1 || typeof value.salt !== 'string' ||
    typeof value.ciphertext !== 'string' || typeof value.nonce !== 'string') {
    throw new Error('Invalid Journal recovery package')
  }
  const identity = await ensureIdentity(deviceId)
  const key = await recoveryKey(secret, decodeBase64Url(value.salt))
  const raw = await decryptRaw(
    key,
    { ciphertext: value.ciphertext, nonce: value.nonce },
    { scope: 'daylight-journal-recovery-v1', deviceId: typeof value.deviceId === 'string' ? value.deviceId : deviceId },
  )
  if (raw.byteLength !== 32) throw new Error('Journal recovery package has an invalid root key')
  await replaceRootKey(identity, raw)
}

/** Create a ten-minute, one-time request that binds approval to this device and public key. */
export async function journalDeviceApprovalIdentity(deviceToken: string): Promise<JsonRecord> {
  const deviceId = parseJournalDeviceId(deviceToken)
  if (!deviceId) throw new Error('Sync is not paired with a Journal device token')
  const identity = await ensureIdentity(deviceId)
  if (identity.wrappedRootKey) throw new Error('This Journal device already has a sync root key')
  const createdAt = Date.now()
  const approvalRequest: ApprovalRequest = {
    nonce: base64Url(randomBytes(32)),
    createdAt,
    expiresAt: createdAt + APPROVAL_REQUEST_TTL_MS,
  }
  await writeIdentity({ ...identity, approvalRequest })
  return {
    version: 2,
    deviceId: identity.deviceId,
    publicKey: normalizeAgreementPublicJwk(identity.publicAgreementJwk),
    requestNonce: approvalRequest.nonce,
    createdAt: approvalRequest.createdAt,
    expiresAt: approvalRequest.expiresAt,
  }
}

/** Wrap the root sync key for another device's public ECDH key without exposing it to the cloud. */
export async function createJournalDeviceApprovalPackage(
  deviceToken: string,
  target: unknown,
): Promise<JsonRecord> {
  const deviceId = parseJournalDeviceId(deviceToken)
  if (!deviceId) throw new Error('Sync is not paired with a Journal device token')
  const request = parseApprovalRequest(target)
  if (request.deviceId === deviceId) throw new Error('A Journal device cannot approve itself')
  const identity = await ensureIdentity(deviceId)
  const peer = await crypto.subtle.importKey(
    'jwk',
    request.publicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peer },
    identity.agreementPrivateKey,
    256,
  )
  const targetPublicKeySha256 = await agreementPublicKeyFingerprint(request.publicKey)
  const context = approvalContext({
    fromDeviceId: deviceId,
    toDeviceId: request.deviceId,
    requestNonce: request.requestNonce,
    targetPublicKeySha256,
  })
  const transport = await approvalTransportKey(shared, request.requestNonce, context)
  const issuedAt = Date.now()
  const expiresAt = Math.min(request.expiresAt, issuedAt + APPROVAL_REQUEST_TTL_MS)
  const wrapped = await encryptRaw(
    transport,
    await rootKeyBytes(identity),
    approvalAad({
      fromDeviceId: deviceId,
      toDeviceId: request.deviceId,
      requestNonce: request.requestNonce,
      targetPublicKeySha256,
      issuedAt,
      expiresAt,
    }),
  )
  return {
    version: 2,
    fromDeviceId: deviceId,
    toDeviceId: request.deviceId,
    requestNonce: request.requestNonce,
    targetPublicKeySha256,
    issuedAt,
    expiresAt,
    senderPublicKey: normalizeAgreementPublicJwk(identity.publicAgreementJwk),
    ...wrapped,
  }
}

async function acceptJournalDeviceApprovalPackageOnce(deviceToken: string, value: unknown): Promise<void> {
  const deviceId = parseJournalDeviceId(deviceToken)
  if (!deviceId || !isRecord(value) || value.version !== 2 || value.toDeviceId !== deviceId ||
    !isDeviceId(value.fromDeviceId) || value.fromDeviceId === deviceId ||
    !isExactBase64UrlBytes(value.requestNonce, 32) || !isSha256(value.targetPublicKeySha256) ||
    !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) ||
    !isBase64Url(value.ciphertext) || !isNonce(value.nonce)) {
    throw new Error('Invalid Journal device approval package')
  }
  const issuedAt = value.issuedAt as number
  const expiresAt = value.expiresAt as number
  const now = Date.now()
  if (issuedAt > now + APPROVAL_CLOCK_SKEW_MS || expiresAt <= now || expiresAt <= issuedAt ||
    expiresAt - issuedAt > APPROVAL_REQUEST_TTL_MS) {
    throw new Error('Journal device approval package is expired or has an invalid lifetime')
  }
  const identity = await ensureIdentity(deviceId)
  if (identity.wrappedRootKey) throw new Error('This Journal device already has a sync root key')
  if (!identity.approvalRequest || identity.approvalRequest.nonce !== value.requestNonce ||
    identity.approvalRequest.expiresAt <= now || expiresAt > identity.approvalRequest.expiresAt ||
    issuedAt < identity.approvalRequest.createdAt - APPROVAL_CLOCK_SKEW_MS) {
    throw new Error('Journal device approval request is missing, expired, or already consumed')
  }
  const localPublicKeySha256 = await agreementPublicKeyFingerprint(identity.publicAgreementJwk)
  if (localPublicKeySha256 !== value.targetPublicKeySha256) {
    throw new Error('Journal device approval package targets a different public key')
  }
  const senderPublicKey = normalizeAgreementPublicJwk(value.senderPublicKey)
  if (!senderPublicKey) throw new Error('Invalid Journal device approval sender key')
  const sender = await crypto.subtle.importKey(
    'jwk',
    senderPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: sender },
    identity.agreementPrivateKey,
    256,
  )
  const context = approvalContext({
    fromDeviceId: value.fromDeviceId,
    toDeviceId: deviceId,
    requestNonce: value.requestNonce,
    targetPublicKeySha256: value.targetPublicKeySha256,
  })
  const transport = await approvalTransportKey(shared, value.requestNonce, context)
  const raw = await decryptRaw(
    transport,
    { ciphertext: value.ciphertext, nonce: value.nonce },
    approvalAad({
      fromDeviceId: value.fromDeviceId,
      toDeviceId: deviceId,
      requestNonce: value.requestNonce,
      targetPublicKeySha256: value.targetPublicKeySha256,
      issuedAt,
      expiresAt,
    }),
  )
  if (raw.byteLength !== 32) throw new Error('Journal device approval package has an invalid root key')
  await replaceRootKey(identity, raw)
}

/** Accept exactly one fresh package for the locally persisted approval request. */
export async function acceptJournalDeviceApprovalPackage(deviceToken: string, value: unknown): Promise<void> {
  if (activeApprovalAcceptance) throw new Error('A Journal device approval is already in progress')
  activeApprovalAcceptance = acceptJournalDeviceApprovalPackageOnce(deviceToken, value)
  try {
    await activeApprovalAcceptance
  } finally {
    activeApprovalAcceptance = null
  }
}

export const journalSyncCrypto = {
  aad: mutationAad,
  objectAad,
  encryptJson,
  decryptJson,
  encryptBytes,
  decryptBytes,
  sha256Bytes,
}
