import { journalFetch } from './http.ts'
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
}

const DATABASE_NAME = 'daylight-journal-encrypted-sync-v1'
const DATABASE_VERSION = 2
const KEY_STORE = 'keys'
const ENTITY_STORE = 'entities'
const OUTBOX_STORE = 'outbox'
const META_STORE = 'meta'
const CONFLICT_STORE = 'conflicts'
const ARCHIVE_STORE = 'archives'
const ROOT_KEY_AAD_PREFIX = 'daylight-journal-root-key-v1'
const LEASE_MS = 45_000
const MAX_MUTATIONS = 25
const MAX_PAGES = 100

let databasePromise: Promise<IDBDatabase> | null = null

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
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value')
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
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
    ? [KEY_STORE, ENTITY_STORE, OUTBOX_STORE, META_STORE, CONFLICT_STORE, ARCHIVE_STORE]
    : [KEY_STORE, META_STORE]
  const transaction = database.transaction(stores, 'readwrite')
  if (changedRoot) {
    const entityStore = transaction.objectStore(ENTITY_STORE)
    const outboxStore = transaction.objectStore(OUTBOX_STORE)
    const metaStore = transaction.objectStore(META_STORE)
    const conflictStore = transaction.objectStore(CONFLICT_STORE)
    const entityRequest = entityStore.getAll()
    const outboxRequest = outboxStore.getAll()
    const metaRequest = metaStore.getAll()
    const conflictRequest = conflictStore.getAll()
    const [entities, outbox, meta, conflicts] = await Promise.all([
      requestResult(entityRequest),
      requestResult(outboxRequest),
      requestResult(metaRequest),
      requestResult(conflictRequest),
    ])
    transaction.objectStore(ARCHIVE_STORE).put({
      id: `root-change-${Date.now()}-${crypto.randomUUID()}`,
      reason: 'root_fingerprint_changed',
      previousFingerprint,
      nextFingerprint,
      entities,
      outbox,
      meta,
      conflicts,
      createdAt: Date.now(),
    })
    entityStore.clear()
    outboxStore.clear()
    metaStore.clear()
    conflictStore.clear()
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

async function readLocalState(): Promise<{ entities: LocalEntity[]; outbox: OutboxItem[]; cursor: string | null }> {
  const database = await openDatabase()
  const transaction = database.transaction([ENTITY_STORE, OUTBOX_STORE, META_STORE], 'readonly')
  const entities = await requestResult(transaction.objectStore(ENTITY_STORE).getAll()) as LocalEntity[]
  const outbox = await requestResult(transaction.objectStore(OUTBOX_STORE).getAll()) as OutboxItem[]
  const cursor = await requestResult(transaction.objectStore(META_STORE).get('cursor')) as MetaRecord | undefined
  await transactionDone(transaction)
  return { entities, outbox, cursor: typeof cursor?.value === 'string' ? cursor.value : null }
}

async function createMutation(
  key: CryptoKey,
  entityId: string,
  baseRevision: number,
  entry: JournalEntry | null,
): Promise<JournalEncryptedMutation> {
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
  if (!entry) return base
  const encrypted = await encryptJson(key, entry, aad)
  return { ...base, ciphertext: encrypted.ciphertext, nonce: encrypted.nonce }
}

async function stageLocalEntries(entries: JournalEntries, key: CryptoKey): Promise<void> {
  const state = await readLocalState()
  const previous = new Map(state.entities.map((entity) => [entity.entityId, entity]))
  const activeByEntity = new Map<string, OutboxItem>()
  for (const item of state.outbox) {
    if (item.state !== 'conflict') activeByEntity.set(item.entityId, item)
  }
  const next = new Map<string, LocalEntity>()
  const pendingDeletes = new Set<string>()
  const mutations: OutboxItem[] = []

  for (const entry of Object.values(entries)) {
    if (!shouldSynchronize(entry)) continue
    const fingerprint = await entryFingerprint(entry)
    const existing = previous.get(entry.date)
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
    const active = activeByEntity.get(entry.date)
    if (active?.state === 'inflight') continue
    if (active?.state === 'pending' || active?.state === 'retry') pendingDeletes.add(active.opId)
    const mutation = await createMutation(key, entry.date, local.confirmedRevision, entry)
    mutations.push({
      ...mutation,
      localFingerprint: fingerprint,
      state: 'pending',
      attemptCount: 0,
      leaseId: null,
      leaseExpiresAt: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  for (const existing of state.entities) {
    if (next.has(existing.entityId) || existing.deleted || !existing.entry) continue
    const active = activeByEntity.get(existing.entityId)
    if (active?.state === 'inflight') {
      next.set(existing.entityId, { ...existing, entry: null, localFingerprint: null, deleted: true, updatedAt: Date.now() })
      continue
    }
    if (active?.state === 'pending' || active?.state === 'retry') pendingDeletes.add(active.opId)
    const mutation = await createMutation(key, existing.entityId, existing.confirmedRevision, null)
    mutations.push({
      ...mutation,
      localFingerprint: null,
      state: 'pending',
      attemptCount: 0,
      leaseId: null,
      leaseExpiresAt: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    next.set(existing.entityId, {
      ...existing,
      entry: null,
      localFingerprint: null,
      deleted: true,
      updatedAt: Date.now(),
    })
  }

  const database = await openDatabase()
  const transaction = database.transaction([ENTITY_STORE, OUTBOX_STORE, META_STORE], 'readwrite')
  const entityStore = transaction.objectStore(ENTITY_STORE)
  const outboxStore = transaction.objectStore(OUTBOX_STORE)
  for (const value of next.values()) entityStore.put(value)
  for (const id of pendingDeletes) outboxStore.delete(id)
  for (const mutation of mutations) outboxStore.put(mutation)
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

async function materializeChanges(
  key: CryptoKey,
  changes: JournalEncryptedChange[],
): Promise<MaterializedChange[]> {
  const result: MaterializedChange[] = []
  for (const change of changes) {
    if (change.entityType !== 'journal_entry' || !isDate(change.entityId)) {
      throw new Error('Encrypted change has an unsupported entity')
    }
    if (change.operation === 'delete') {
      if (change.ciphertext !== null || change.nonce !== null || change.objects.length !== 0) {
        throw new Error('Encrypted delete change has payload material')
      }
      result.push({ change, entry: null })
      continue
    }
    if (!change.ciphertext || !change.nonce || change.objects.length) {
      throw new Error('Encrypted attachment objects require an object-store client')
    }
    const expectedHash = await aadHash({
      entityId: change.entityId,
      operation: change.operation,
      keyVersion: change.keyVersion,
      revision: change.revision,
    })
    if (expectedHash !== change.aadHash) throw new Error('Encrypted change AAD does not match its metadata')
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
    result.push({ change, entry: parseRemoteEntry(change.entityId, decrypted) })
  }
  return result
}

function isExchangeResponse(value: unknown): value is JournalExchangeResponse {
  return isRecord(value) && value.protocolVersion === 2 && value.envelopeVersion === 1 &&
    value.product === 'journal' && Array.isArray(value.acknowledged) && Array.isArray(value.conflicts) &&
    Array.isArray(value.changes) && typeof value.nextCursor === 'string' && /^c[0-9a-z]+$/.test(value.nextCursor) &&
    typeof value.hasMore === 'boolean' && typeof value.serverTime === 'string'
}

async function applyResponse(
  response: JournalExchangeResponse,
  leaseId: string,
  materialized: MaterializedChange[],
): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction([ENTITY_STORE, OUTBOX_STORE, META_STORE, CONFLICT_STORE], 'readwrite')
  const entities = transaction.objectStore(ENTITY_STORE)
  const outbox = transaction.objectStore(OUTBOX_STORE)
  const conflicts = transaction.objectStore(CONFLICT_STORE)
  const entityValues = await requestResult(entities.getAll()) as LocalEntity[]
  const outboxValues = await requestResult(outbox.getAll()) as OutboxItem[]
  const entityById = new Map(entityValues.map((entry) => [entry.entityId, entry]))
  const outboxById = new Map(outboxValues.map((entry) => [entry.opId, entry]))
  const protectedLocal = new Set<string>()

  for (const acknowledgement of response.acknowledged) {
    const item = outboxById.get(acknowledgement.opId)
    if (!item || item.leaseId !== leaseId) continue
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
    outbox.delete(item.opId)
    outboxById.delete(item.opId)
  }

  for (const conflict of response.conflicts) {
    const item = outboxById.get(conflict.opId)
    if (!item || item.leaseId !== leaseId) continue
    outbox.put({
      ...item,
      state: 'conflict',
      leaseId: null,
      leaseExpiresAt: null,
      error: conflict.error,
      updatedAt: Date.now(),
    })
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

  for (const materializedChange of materialized) {
    const { change, entry } = materializedChange
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
    entityById.set(change.entityId, {
      entityId: change.entityId,
      entry,
      localFingerprint: entry ? await entryFingerprint(entry) : null,
      confirmedRevision: change.revision,
      confirmedFingerprint: entry ? await entryFingerprint(entry) : null,
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

/** Encrypt, exchange, materialize, and ACK Journal state without sending business plaintext to the cloud. */
export async function syncEncryptedJournal(input: {
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
  await stageLocalEntries(input.entries, key)
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const state = await readLocalState()
    const claimed = await claimOutbox()
    let response: JournalExchangeResponse
    try {
      response = await postExchange(input.endpoint, input.deviceToken, deviceId, state.cursor, claimed.items)
    } catch (error) {
      await retryLease(claimed.leaseId, error instanceof Error ? error.message : 'network')
      throw error
    }
    const materialized = await materializeChanges(key, response.changes)
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

/** Return public device agreement metadata for an already authorized device approval flow. */
export async function journalDeviceApprovalIdentity(deviceToken: string): Promise<JsonRecord> {
  const deviceId = parseJournalDeviceId(deviceToken)
  if (!deviceId) throw new Error('Sync is not paired with a Journal device token')
  const identity = await ensureIdentity(deviceId)
  return { version: 1, deviceId: identity.deviceId, publicKey: identity.publicAgreementJwk }
}

/** Wrap the root sync key for another device's public ECDH key without exposing it to the cloud. */
export async function createJournalDeviceApprovalPackage(
  deviceToken: string,
  target: unknown,
): Promise<JsonRecord> {
  const deviceId = parseJournalDeviceId(deviceToken)
  if (!deviceId || !isRecord(target) || typeof target.deviceId !== 'string' || !isRecord(target.publicKey)) {
    throw new Error('Invalid Journal device approval target')
  }
  const identity = await ensureIdentity(deviceId)
  const peer = await crypto.subtle.importKey(
    'jwk',
    target.publicKey as JsonWebKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peer },
    identity.agreementPrivateKey,
    256,
  )
  const transport = await crypto.subtle.importKey('raw', shared, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const wrapped = await encryptRaw(
    transport,
    await rootKeyBytes(identity),
    { scope: 'daylight-journal-device-approval-v1', fromDeviceId: deviceId, toDeviceId: target.deviceId },
  )
  return {
    version: 1,
    fromDeviceId: deviceId,
    toDeviceId: target.deviceId,
    senderPublicKey: identity.publicAgreementJwk,
    ...wrapped,
  }
}

/** Accept an approval package on its designated device and rewrap the shared root under that device's non-exportable key. */
export async function acceptJournalDeviceApprovalPackage(deviceToken: string, value: unknown): Promise<void> {
  const deviceId = parseJournalDeviceId(deviceToken)
  if (!deviceId || !isRecord(value) || value.version !== 1 || value.toDeviceId !== deviceId ||
    !isRecord(value.senderPublicKey) || typeof value.fromDeviceId !== 'string' ||
    typeof value.ciphertext !== 'string' || typeof value.nonce !== 'string') {
    throw new Error('Invalid Journal device approval package')
  }
  const identity = await ensureIdentity(deviceId)
  const sender = await crypto.subtle.importKey(
    'jwk',
    value.senderPublicKey as JsonWebKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: sender },
    identity.agreementPrivateKey,
    256,
  )
  const transport = await crypto.subtle.importKey('raw', shared, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const raw = await decryptRaw(
    transport,
    { ciphertext: value.ciphertext, nonce: value.nonce },
    { scope: 'daylight-journal-device-approval-v1', fromDeviceId: value.fromDeviceId, toDeviceId: deviceId },
  )
  if (raw.byteLength !== 32) throw new Error('Journal device approval package has an invalid root key')
  await replaceRootKey(identity, raw)
}

export const journalSyncCrypto = {
  aad: mutationAad,
  encryptJson,
  decryptJson,
}
