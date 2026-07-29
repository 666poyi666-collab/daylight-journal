import {
  JournalEncryptedSync,
  base64Url,
  decryptMutation,
  emptySyncSnapshot,
  encryptMutation,
  mutationFromRecord,
  stableJson,
  type EncryptedAcknowledgement,
  type EncryptedChange,
  type EncryptedConflict,
  type EncryptedMutation,
  type EncryptedObjectRef,
  type EncryptedState,
  type PendingLegacyImport,
  type RootKeyBundle,
  type SyncRecord,
  type SyncSnapshot,
  type SyncStore,
} from './encrypted-sync.ts'
import {
  decodeJournalEntries,
  hasEntryContent,
  journalBlocksToContent,
  type JournalEntries,
  type JournalEntry,
} from './model.ts'
import type { StorageLike } from './storage.ts'

export const JOURNAL_ROOT_KEY_STORAGE_KEY = 'daylight-journal-sync-root-v1'
const SYNC_STORAGE_PREFIX = 'daylight-journal-sync-v2'
const MAX_EXCHANGE_ROUNDS = 200
const encoder = new TextEncoder()

type Fetcher = typeof fetch

type JournalEncryptedPayload = {
  entry: Omit<JournalEntry, 'coverImage'>
}

type ExchangeResponse = {
  protocolVersion: 2
  envelopeVersion: 1
  product: 'journal'
  acknowledged: EncryptedAcknowledgement[]
  conflicts: EncryptedConflict[]
  changes: EncryptedChange[]
  nextCursor: string
  hasMore: boolean
  legacyImports: LegacyJournalImport[]
  legacyHasMore: boolean
  serverTime: string
}

type LegacyJournalImport = PendingLegacyImport & {
  entry: Omit<JournalEntry, 'coverImage'>
}

export type JournalV2SyncResult = {
  entries: JournalEntries
  conflictCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16}$/.test(value)
}

function isEncryptedObjectRef(value: unknown): value is EncryptedObjectRef {
  return isRecord(value) &&
    typeof value.objectKey === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/.test(value.objectKey) &&
    !value.objectKey.includes('..') &&
    isSha256(value.ciphertextSha256) &&
    Number.isSafeInteger(value.ciphertextBytes) &&
    Number(value.ciphertextBytes) > 0 &&
    isNonce(value.nonce) &&
    isSha256(value.aadHash) &&
    Number.isSafeInteger(value.keyVersion) &&
    Number(value.keyVersion) > 0
}

function isEncryptedMutation(value: unknown): value is EncryptedMutation {
  if (!isRecord(value)) return false
  const operation = value.operation
  return isUuid(value.opId) &&
    value.entityType === 'journal_entry' &&
    isDate(value.entityId) &&
    Number.isSafeInteger(value.baseRevision) &&
    Number(value.baseRevision) >= 0 &&
    (operation === 'upsert' || operation === 'delete') &&
    Number.isSafeInteger(value.keyVersion) &&
    Number(value.keyVersion) > 0 &&
    isSha256(value.aadHash) &&
    Array.isArray(value.objects) &&
    value.objects.every(isEncryptedObjectRef) &&
    Array.isArray(value.migrationIds) &&
    value.migrationIds.length <= 25 &&
    value.migrationIds.every(isUuid) &&
    new Set(value.migrationIds).size === value.migrationIds.length &&
    (operation === 'delete'
      ? value.ciphertext === null && value.ciphertextSha256 === null && value.nonce === null && value.objects.length === 0 && value.migrationIds.length === 0
      : typeof value.ciphertext === 'string' &&
        /^[A-Za-z0-9_-]+$/.test(value.ciphertext) &&
        isSha256(value.ciphertextSha256) &&
        isNonce(value.nonce))
}

function isEncryptedState(value: unknown): value is EncryptedState {
  if (!isRecord(value)) return false
  const candidate = {
    opId: crypto.randomUUID(),
    entityType: value.entityType,
    entityId: value.entityId,
    baseRevision: Number(value.revision) - 1,
    operation: value.operation,
    keyVersion: value.keyVersion,
    ciphertext: value.ciphertext,
    ciphertextSha256: value.ciphertextSha256,
    nonce: value.nonce,
    aadHash: value.aadHash,
    objects: value.objects,
    migrationIds: [],
  }
  return isEncryptedMutation(candidate) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    (value.deletedAt === null || isTimestamp(value.deletedAt)) &&
    isTimestamp(value.updatedAt)
}

function isEncryptedConflict(value: unknown): value is EncryptedConflict {
  return isRecord(value) &&
    value.outcome === 'conflict' &&
    isUuid(value.opId) &&
    value.entityType === 'journal_entry' &&
    isDate(value.entityId) &&
    (value.operation === 'upsert' || value.operation === 'delete') &&
    typeof value.error === 'string' &&
    (value.retryable === undefined || typeof value.retryable === 'boolean') &&
    (value.current === null || isEncryptedState(value.current)) &&
    (value.candidate === null || isEncryptedMutation(value.candidate))
}

function isSyncRecord(value: unknown): value is SyncRecord {
  if (!isRecord(value)) return false
  const mutation = {
    opId: isUuid(value.operationId) ? value.operationId : crypto.randomUUID(),
    entityType: 'journal_entry',
    entityId: '2000-01-01',
    baseRevision: Number(value.revision) - 1,
    operation: value.deleted ? 'delete' : 'upsert',
    keyVersion: value.keyVersion,
    ciphertext: value.ciphertext,
    ciphertextSha256: value.ciphertextSha256,
    nonce: value.nonce,
    aadHash: value.aadHash,
    objects: value.objects,
    migrationIds: [],
  }
  return Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    typeof value.deleted === 'boolean' &&
    isEncryptedMutation(mutation) &&
    isTimestamp(value.changedAt) &&
    (value.operationId === null || isUuid(value.operationId)) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.every(isEncryptedConflict)
}

function parseLegacyImport(value: unknown): LegacyJournalImport | null {
  if (
    !isRecord(value) ||
    !isUuid(value.migrationId) ||
    !isDate(value.targetDate) ||
    !Number.isSafeInteger(value.legacyRevision) ||
    Number(value.legacyRevision) < 1 ||
    !isRecord(value.entry) ||
    Object.hasOwn(value.entry, 'coverImage')
  ) return null
  const decoded = decodeJournalEntries({ [value.targetDate]: value.entry })
  const entry = decoded.entries[value.targetDate]
  if (decoded.invalidRoot || decoded.invalidKeys.length || !entry) return null
  const { coverImage: _coverImage, ...attachmentFree } = entry
  return {
    migrationId: value.migrationId,
    targetDate: value.targetDate,
    legacyRevision: Number(value.legacyRevision),
    entry: attachmentFree,
  }
}

function parseSnapshot(raw: string): SyncSnapshot {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value) || (value.cursor !== null && (typeof value.cursor !== 'string' || !/^c[0-9a-z]+$/.test(value.cursor)))) {
    throw new Error('invalid_sync_snapshot')
  }
  if (!isRecord(value.records) || !Array.isArray(value.outbox) || !isRecord(value.attachments)) {
    throw new Error('invalid_sync_snapshot')
  }
  for (const mutation of value.outbox) {
    if (isRecord(mutation) && mutation.migrationIds === undefined) mutation.migrationIds = []
  }
  const pendingDeletes = value.pendingDeletes === undefined ? [] : value.pendingDeletes
  if (!Array.isArray(pendingDeletes) || !pendingDeletes.every(isDate)) throw new Error('invalid_sync_snapshot')
  const pendingLegacyImports = value.pendingLegacyImports === undefined ? [] : value.pendingLegacyImports
  const parsedLegacyImports = Array.isArray(pendingLegacyImports)
    ? pendingLegacyImports.map(parseLegacyImport)
    : []
  if (
    !Array.isArray(pendingLegacyImports) ||
    parsedLegacyImports.some((item) => item === null) ||
    (value.legacyHasMore !== undefined && typeof value.legacyHasMore !== 'boolean')
  ) throw new Error('invalid_sync_snapshot')
  for (const [entityId, record] of Object.entries(value.records)) {
    if (!isDate(entityId) || !isSyncRecord(record)) throw new Error('invalid_sync_snapshot')
  }
  if (!value.outbox.every(isEncryptedMutation)) throw new Error('invalid_sync_snapshot')
  for (const [objectKey, attachment] of Object.entries(value.attachments)) {
    if (
      !isRecord(attachment) ||
      !isEncryptedObjectRef(attachment.ref) ||
      attachment.ref.objectKey !== objectKey ||
      typeof attachment.ciphertext !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(attachment.ciphertext) ||
      typeof attachment.uploaded !== 'boolean'
    ) {
      throw new Error('invalid_sync_snapshot')
    }
  }
  return {
    ...JSON.parse(JSON.stringify(value)) as SyncSnapshot,
    pendingDeletes: [...pendingDeletes],
    pendingLegacyImports: parsedLegacyImports as LegacyJournalImport[],
    legacyHasMore: value.legacyHasMore ?? false,
  }
}

export class BrowserSyncStore implements SyncStore {
  private readonly storage: StorageLike
  private readonly key: string

  constructor(storage: StorageLike, baseUrl: string, deviceId: string) {
    this.storage = storage
    const origin = new URL(baseUrl).origin
    this.key = `${SYNC_STORAGE_PREFIX}:${base64Url(encoder.encode(origin))}:${deviceId}`
  }

  async read(): Promise<SyncSnapshot> {
    const raw = this.storage.getItem(this.key)
    return raw ? parseSnapshot(raw) : emptySyncSnapshot()
  }

  async write(snapshot: SyncSnapshot): Promise<void> {
    this.storage.setItem(this.key, JSON.stringify(snapshot))
  }
}

export function deviceIdFromToken(token: string): string | null {
  const match = /^dj1\.([A-Za-z0-9][A-Za-z0-9_-]{2,127})\.[A-Za-z0-9_-]{32,}$/.exec(token.trim())
  return match?.[1] ?? null
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid_sync_url')
  return url.href.replace(/\/$/, '')
}

function payloadFromEntry(entry: JournalEntry): JournalEncryptedPayload {
  const { coverImage: _localOnlyCover, ...withoutCover } = entry
  return { entry: withoutCover }
}

function parsePayload(value: unknown, entityId: string): JournalEncryptedPayload {
  if (!isRecord(value) || !isRecord(value.entry)) throw new Error('invalid_encrypted_journal_payload')
  if (Object.hasOwn(value.entry, 'coverImage')) {
    throw new Error('invalid_encrypted_journal_payload')
  }
  const decoded = decodeJournalEntries({ [entityId]: value.entry })
  if (decoded.invalidRoot || decoded.invalidKeys.length || !decoded.entries[entityId]) {
    throw new Error('invalid_encrypted_journal_payload')
  }
  return { entry: decoded.entries[entityId] }
}

function stateAsMutation(state: EncryptedState): EncryptedMutation {
  return {
    opId: crypto.randomUUID(),
    entityType: 'journal_entry',
    entityId: state.entityId,
    baseRevision: state.revision - 1,
    operation: state.operation,
    keyVersion: state.keyVersion,
    ciphertext: state.ciphertext,
    ciphertextSha256: state.ciphertextSha256,
    nonce: state.nonce,
    aadHash: state.aadHash,
    objects: state.objects,
    migrationIds: [],
  }
}

function changeAsMutation(change: EncryptedChange): EncryptedMutation {
  return {
    opId: change.operationId,
    entityType: 'journal_entry',
    entityId: change.entityId,
    baseRevision: change.revision - 1,
    operation: change.operation,
    keyVersion: change.keyVersion,
    ciphertext: change.ciphertext,
    ciphertextSha256: change.ciphertextSha256,
    nonce: change.nonce,
    aadHash: change.aadHash,
    objects: change.objects,
    migrationIds: [],
  }
}

function parseExchangeResponse(value: unknown): ExchangeResponse {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 2 ||
    value.envelopeVersion !== 1 ||
    value.product !== 'journal' ||
    !Array.isArray(value.acknowledged) ||
    !Array.isArray(value.conflicts) ||
    !Array.isArray(value.changes) ||
    typeof value.nextCursor !== 'string' ||
    !/^c[0-9a-z]+$/.test(value.nextCursor) ||
    typeof value.hasMore !== 'boolean' ||
    !Array.isArray(value.legacyImports) ||
    typeof value.legacyHasMore !== 'boolean' ||
    !isTimestamp(value.serverTime)
  ) {
    throw new Error('invalid_v2_exchange_response')
  }
  const acknowledged = value.acknowledged as unknown[]
  if (!acknowledged.every((item) =>
    isRecord(item) &&
    item.outcome === 'acknowledged' &&
    isUuid(item.opId) &&
    item.entityType === 'journal_entry' &&
    isDate(item.entityId) &&
    (item.operation === 'upsert' || item.operation === 'delete') &&
    Number.isSafeInteger(item.revision) &&
    Number(item.revision) > 0 &&
    (item.replayed === undefined || typeof item.replayed === 'boolean'),
  )) throw new Error('invalid_v2_exchange_response')
  if (!value.conflicts.every(isEncryptedConflict)) throw new Error('invalid_v2_exchange_response')
  if (!value.changes.every((item) => {
    if (!isRecord(item) || !isUuid(item.operationId) || !isTimestamp(item.changedAt) || typeof item.originDeviceId !== 'string') return false
    return isEncryptedMutation({
      ...item,
      opId: item.operationId,
      baseRevision: Number(item.revision) - 1,
      migrationIds: [],
    })
  })) throw new Error('invalid_v2_exchange_response')
  const legacyImports = value.legacyImports.map(parseLegacyImport)
  if (
    legacyImports.some((item) => item === null) ||
    new Set(legacyImports.map((item) => item?.migrationId)).size !== legacyImports.length
  ) throw new Error('invalid_v2_exchange_response')
  return { ...value, legacyImports: legacyImports as LegacyJournalImport[] } as ExchangeResponse
}

function latestChangesForResponse(response: ExchangeResponse): EncryptedChange[] {
  const latest = new Map<string, EncryptedChange>()
  for (const change of response.changes) {
    const current = latest.get(change.entityId)
    if (!current || change.revision > current.revision) latest.set(change.entityId, change)
  }
  return [...latest.values()]
}

function blockFingerprint(block: JournalEntry['blocks'][number]): string {
  const { id: _id, ...semantic } = block
  return stableJson(semantic)
}

function entryFingerprint(entry: Omit<JournalEntry, 'coverImage'>): string {
  return stableJson({
    title: entry.title,
    content: entry.content,
    blocks: entry.blocks.map(blockFingerprint),
    mood: entry.mood,
    tags: [...entry.tags].sort(),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  })
}

function mergeLegacyEntry(
  current: JournalEntry | undefined,
  legacy: Omit<JournalEntry, 'coverImage'>,
  migrationId: string,
): JournalEntry {
  if (!current) return { ...legacy, blocks: legacy.blocks.map((block) => ({ ...block })) }
  const { coverImage: _coverImage, ...attachmentFreeCurrent } = current
  if (entryFingerprint(attachmentFreeCurrent) === entryFingerprint(legacy)) return current

  const blocks = current.blocks.map((block) => ({ ...block }))
  const blockFingerprints = new Set(blocks.map(blockFingerprint))
  const blockIds = new Set(blocks.map((block) => block.id))
  for (const [index, source] of legacy.blocks.entries()) {
    const fingerprint = blockFingerprint(source)
    if (blockFingerprints.has(fingerprint)) continue
    let id = source.id
    if (blockIds.has(id)) id = `legacy-${migrationId}-${index + 1}`
    blocks.push({ ...source, id })
    blockIds.add(id)
    blockFingerprints.add(fingerprint)
  }

  const legacyIsNewer = Date.parse(legacy.updatedAt) > Date.parse(current.updatedAt)
  return {
    schemaVersion: 2,
    date: current.date,
    title: legacyIsNewer ? legacy.title : current.title,
    content: journalBlocksToContent(blocks),
    blocks,
    mood: legacyIsNewer ? legacy.mood : current.mood,
    tags: [...new Set([...current.tags, ...legacy.tags])],
    ...(current.coverImage ? { coverImage: current.coverImage } : {}),
    createdAt: Date.parse(legacy.createdAt) < Date.parse(current.createdAt)
      ? legacy.createdAt
      : current.createdAt,
    updatedAt: legacyIsNewer ? legacy.updatedAt : current.updatedAt,
  }
}

export class JournalV2SyncClient {
  private readonly baseUrl: string
  private readonly deviceId: string
  private readonly deviceToken: string
  private readonly root: RootKeyBundle
  private readonly store: SyncStore
  private readonly fetcher: Fetcher
  private readonly encrypted: JournalEncryptedSync

  constructor(options: {
    baseUrl: string
    deviceToken: string
    rootKey: RootKeyBundle
    store: SyncStore
    fetcher?: Fetcher
  }) {
    const deviceId = deviceIdFromToken(options.deviceToken)
    if (!deviceId) throw new Error('invalid_device_token')
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.deviceId = deviceId
    this.deviceToken = options.deviceToken.trim()
    this.root = options.rootKey
    this.store = options.store
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init))
    this.encrypted = new JournalEncryptedSync(options.store)
  }

  async synchronize(localEntries: JournalEntries): Promise<JournalV2SyncResult> {
    await this.drain(false)
    await this.drain(true)

    let state = await this.store.read()
    for (let round = 0; round < MAX_EXCHANGE_ROUNDS; round += 1) {
      const remoteEntries = await this.materialize(state)
      const desired = this.mergeDesired(localEntries, remoteEntries, state)
      const migrations = this.mergePendingLegacyImports(desired, state.pendingLegacyImports)
      await this.reconcile(migrations.entries, state, migrations.idsByDate)
      await this.drain(false)
      state = await this.store.read()
      if (state.pendingLegacyImports.length === 0 && !state.legacyHasMore) break
      if (state.pendingLegacyImports.length === 0) {
        await this.drain(true)
        const refreshed = await this.store.read()
        if (refreshed.pendingLegacyImports.length === 0 && refreshed.legacyHasMore) {
          throw new Error('legacy_migration_made_no_progress')
        }
        state = refreshed
      }
      if (round === MAX_EXCHANGE_ROUNDS - 1) throw new Error('legacy_migration_round_limit')
    }
    return {
      entries: this.preserveLocalCovers(await this.materialize(state), localEntries),
      conflictCount: Object.values(state.records).reduce((sum, record) => sum + record.conflicts.length, 0),
    }
  }

  /** Queue an explicit whole-entry tombstone before the plaintext view is removed. */
  async queueDelete(entityId: string): Promise<void> {
    if (!isDate(entityId)) throw new Error('invalid_entity_id')
    let state = await this.store.read()
    const record = state.records[entityId]
    if (record?.deleted) return
    await this.encrypted.markDeleteIntent(entityId)
    state = await this.store.read()
    const mutation = await encryptMutation(this.root, {
      opId: crypto.randomUUID(),
      entityId,
      baseRevision: state.records[entityId]?.revision ?? 0,
      operation: 'delete',
    }, null)
    await this.encrypted.queue(mutation)
  }

  private headers(json = false): Record<string, string> {
    return {
      Authorization: `Bearer ${this.deviceToken}`,
      'X-Journal-Device-Id': this.deviceId,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }
  }

  private async exchange(batch: EncryptedMutation[], cursor: string | null): Promise<ExchangeResponse> {
    const mutations = await Promise.all(batch.map(async (mutation) => ({
      ...mutation,
      objects: [],
      mcpEntry: mutation.operation === 'delete'
        ? null
        : parsePayload(await decryptMutation(this.root, mutation), mutation.entityId).entry,
    })))
    const response = await this.fetcher(`${this.baseUrl}/sync/v2/exchange`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        protocolVersion: 2,
        envelopeVersion: 1,
        product: 'journal',
        deviceId: this.deviceId,
        cursor,
        mutations,
      }),
    })
    if (!response.ok) throw new Error(`v2_exchange_failed:${response.status}`)
    return parseExchangeResponse(await response.json())
  }

  private async validateRemote(response: ExchangeResponse): Promise<void> {
    const validate = async (mutation: EncryptedMutation) => {
      if (mutation.operation === 'delete') return
      parsePayload(await decryptMutation(this.root, mutation), mutation.entityId)
    }
    for (const change of latestChangesForResponse(response)) await validate(changeAsMutation(change))
    for (const conflict of response.conflicts) {
      if (conflict.current) await validate(stateAsMutation(conflict.current))
      if (conflict.candidate) await validate(conflict.candidate)
    }
  }

  private async drain(forcePull: boolean): Promise<void> {
    let exchangeRequired = forcePull
    for (let round = 0; round < MAX_EXCHANGE_ROUNDS; round += 1) {
      let state = await this.store.read()
      if (!exchangeRequired && state.outbox.length === 0) return
      const batch = state.outbox.slice(0, 25)
      const response = await this.exchange(batch, state.cursor)
      await this.validateRemote(response)
      await this.encrypted.applyExchange(
        response.acknowledged,
        response.conflicts,
        response.changes,
        response.nextCursor,
        [],
        response.legacyImports,
        response.legacyHasMore,
      )
      const next = await this.store.read()
      const progressed = response.acknowledged.length > 0 ||
        response.conflicts.some((conflict) => !conflict.retryable) ||
        response.changes.length > 0 ||
        response.legacyImports.length > 0 ||
        next.cursor !== state.cursor
      if (!progressed && next.outbox.length > 0) throw new Error('v2_exchange_made_no_progress')
      exchangeRequired = response.hasMore || next.outbox.length > 0
      if (!exchangeRequired) return
    }
    throw new Error('v2_exchange_round_limit')
  }

  private async materialize(state: SyncSnapshot): Promise<JournalEntries> {
    const entries: JournalEntries = {}
    for (const [entityId, record] of Object.entries(state.records)) {
      if (record.deleted) continue
      const mutation = mutationFromRecord(entityId, record)
      const payload = parsePayload(
        await decryptMutation(this.root, mutation),
        entityId,
      )
      entries[entityId] = payload.entry
    }
    return entries
  }

  private preserveLocalCovers(
    entries: JournalEntries,
    local: JournalEntries,
  ): JournalEntries {
    const preserved = { ...entries }
    for (const [date, localEntry] of Object.entries(local)) {
      const entry = preserved[date]
      if (entry && localEntry.coverImage) {
        preserved[date] = { ...entry, coverImage: localEntry.coverImage }
      }
    }
    return preserved
  }

  private mergeDesired(
    local: JournalEntries,
    remote: JournalEntries,
    state: SyncSnapshot,
  ): JournalEntries {
    const desired = { ...remote }
    for (const [date, entry] of Object.entries(local)) {
      if (!hasEntryContent(entry)) continue
      const record = state.records[date]
      if (record?.deleted) {
        if (Date.parse(entry.updatedAt) > Date.parse(record.changedAt)) desired[date] = entry
        else delete desired[date]
        continue
      }
      const remoteEntry = remote[date]
      if (!remoteEntry || Date.parse(entry.updatedAt) >= Date.parse(remoteEntry.updatedAt)) {
        desired[date] = entry
      }
    }
    for (const entityId of state.pendingDeletes) delete desired[entityId]
    return this.preserveLocalCovers(desired, local)
  }

  private mergePendingLegacyImports(
    desired: JournalEntries,
    pending: PendingLegacyImport[],
  ): { entries: JournalEntries; idsByDate: Map<string, string[]> } {
    const entries = { ...desired }
    const idsByDate = new Map<string, string[]>()
    for (const pendingImport of pending) {
      const legacyImport = parseLegacyImport(pendingImport)
      if (!legacyImport) throw new Error('invalid_pending_legacy_import')
      entries[legacyImport.targetDate] = mergeLegacyEntry(
        entries[legacyImport.targetDate],
        legacyImport.entry,
        legacyImport.migrationId,
      )
      idsByDate.set(legacyImport.targetDate, [
        ...(idsByDate.get(legacyImport.targetDate) ?? []),
        legacyImport.migrationId,
      ])
    }
    return { entries, idsByDate }
  }

  private async reconcile(
    desired: JournalEntries,
    initialState: SyncSnapshot,
    migrationIdsByDate = new Map<string, string[]>(),
  ): Promise<void> {
    let state = initialState
    let currentEntries = await this.materialize(state)
    const entityIds = new Set([
      ...Object.keys(state.records),
      ...Object.keys(desired),
      ...state.pendingDeletes,
    ])
    for (const entityId of entityIds) {
      const target = desired[entityId]
      const record = state.records[entityId]
      if (!target) {
        if (state.pendingDeletes.includes(entityId) && (!record || !record.deleted)) {
          const mutation = await encryptMutation(this.root, {
            opId: crypto.randomUUID(),
            entityId,
            baseRevision: record?.revision ?? 0,
            operation: 'delete',
          }, null)
          await this.encrypted.queue(mutation)
          state = await this.store.read()
          delete currentEntries[entityId]
        }
        continue
      }
      const current = currentEntries[entityId]
      const migrationIds = migrationIdsByDate.get(entityId) ?? []
      if (
        migrationIds.length === 0 &&
        current &&
        stableJson(payloadFromEntry(current)) === stableJson(payloadFromEntry(target))
      ) continue
      const baseRevision = record?.revision ?? 0
      const mutation = await encryptMutation(this.root, {
        opId: crypto.randomUUID(),
        entityId,
        baseRevision,
        operation: 'upsert',
        migrationIds,
      }, payloadFromEntry(target))
      await this.encrypted.queue(mutation, [], target.updatedAt)
      state = await this.store.read()
      currentEntries[entityId] = target
    }
  }
}
