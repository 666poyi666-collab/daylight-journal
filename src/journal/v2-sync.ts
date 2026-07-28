import {
  JournalEncryptedSync,
  base64Url,
  decryptAttachment,
  decryptMutation,
  emptySyncSnapshot,
  encryptAttachment,
  encryptMutation,
  fromBase64Url,
  mutationFromRecord,
  stableJson,
  type AttachmentUpload,
  type EncryptedAcknowledgement,
  type EncryptedChange,
  type EncryptedConflict,
  type EncryptedMutation,
  type EncryptedObjectRef,
  type EncryptedState,
  type RootKeyBundle,
  type SyncRecord,
  type SyncSnapshot,
  type SyncStore,
} from './encrypted-sync.ts'
import {
  decodeJournalEntries,
  hasEntryContent,
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
  coverMediaType: string | null
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
  serverTime: string
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
    (operation === 'delete'
      ? value.ciphertext === null && value.ciphertextSha256 === null && value.nonce === null && value.objects.length === 0
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

function parseSnapshot(raw: string): SyncSnapshot {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value) || (value.cursor !== null && (typeof value.cursor !== 'string' || !/^c[0-9a-z]+$/.test(value.cursor)))) {
    throw new Error('invalid_sync_snapshot')
  }
  if (!isRecord(value.records) || !Array.isArray(value.outbox) || !isRecord(value.attachments)) {
    throw new Error('invalid_sync_snapshot')
  }
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
  return JSON.parse(JSON.stringify(value)) as SyncSnapshot
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

function parseDataUrl(value: string): { mediaType: string; bytes: Uint8Array } {
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (!match) throw new Error('invalid_cover_data_url')
  const binary = atob(match[2])
  return {
    mediaType: match[1],
    bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  }
}

function bytesToDataUrl(mediaType: string, bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:${mediaType};base64,${btoa(binary)}`
}

function payloadFromEntry(entry: JournalEntry): JournalEncryptedPayload {
  const { coverImage, ...withoutCover } = entry
  return {
    entry: withoutCover,
    coverMediaType: coverImage ? parseDataUrl(coverImage).mediaType : null,
  }
}

function parsePayload(value: unknown, entityId: string, objectCount: number): JournalEncryptedPayload {
  if (!isRecord(value) || !isRecord(value.entry)) throw new Error('invalid_encrypted_journal_payload')
  if (value.coverMediaType !== null && !/^image\/(?:jpeg|png|webp|gif)$/.test(String(value.coverMediaType))) {
    throw new Error('invalid_encrypted_journal_payload')
  }
  if ((value.coverMediaType === null ? 0 : 1) !== objectCount || Object.hasOwn(value.entry, 'coverImage')) {
    throw new Error('invalid_encrypted_journal_payload')
  }
  const decoded = decodeJournalEntries({ [entityId]: value.entry })
  if (decoded.invalidRoot || decoded.invalidKeys.length || !decoded.entries[entityId]) {
    throw new Error('invalid_encrypted_journal_payload')
  }
  return {
    entry: decoded.entries[entityId],
    coverMediaType: value.coverMediaType as string | null,
  }
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
    })
  })) throw new Error('invalid_v2_exchange_response')
  return value as ExchangeResponse
}

function manifestHeaders(ref: EncryptedObjectRef): Record<string, string> {
  return {
    'X-Ciphertext-Sha256': ref.ciphertextSha256,
    'X-Ciphertext-Bytes': String(ref.ciphertextBytes),
    'X-Object-Nonce': ref.nonce,
    'X-Object-Aad-Hash': ref.aadHash,
    'X-Key-Version': String(ref.keyVersion),
  }
}

function assertManifestHeaders(response: Response, ref: EncryptedObjectRef): void {
  for (const [name, expected] of Object.entries(manifestHeaders(ref))) {
    if (response.headers.get(name) !== expected) throw new Error('attachment_manifest_mismatch')
  }
}

function refsForResponse(response: ExchangeResponse): EncryptedObjectRef[] {
  const latest = new Map<string, EncryptedChange>()
  for (const change of response.changes) latest.set(change.entityId, change)
  const refs = [...latest.values()].flatMap((change) => change.operation === 'upsert' ? change.objects : [])
  for (const conflict of response.conflicts) {
    if (conflict.current?.operation === 'upsert') refs.push(...conflict.current.objects)
  }
  return [...new Map(refs.map((ref) => [ref.objectKey, ref])).values()]
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
    this.fetcher = options.fetcher ?? fetch
    this.encrypted = new JournalEncryptedSync(options.store)
  }

  async synchronize(localEntries: JournalEntries): Promise<JournalV2SyncResult> {
    await this.drain(true)
    let state = await this.store.read()
    const remoteEntries = await this.materialize(state)
    const desired = this.mergeDesired(localEntries, remoteEntries, state)
    await this.reconcile(desired, state)
    await this.drain(false)
    state = await this.store.read()
    return {
      entries: await this.materialize(state),
      conflictCount: Object.values(state.records).reduce((sum, record) => sum + record.conflicts.length, 0),
    }
  }

  /** Queue an explicit whole-entry tombstone before the plaintext view is removed. */
  async queueDelete(entityId: string): Promise<void> {
    if (!isDate(entityId)) throw new Error('invalid_entity_id')
    const state = await this.store.read()
    const record = state.records[entityId]
    if (!record || record.deleted) return
    const mutation = await encryptMutation(this.root, {
      opId: crypto.randomUUID(),
      entityId,
      baseRevision: record.revision,
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

  private async uploadAttachment(upload: AttachmentUpload): Promise<void> {
    const response = await this.fetcher(
      `${this.baseUrl}/sync/v2/objects/${encodeURIComponent(upload.ref.objectKey)}`,
      {
        method: 'PUT',
        headers: {
          ...this.headers(),
          ...manifestHeaders(upload.ref),
          'Content-Type': 'application/octet-stream',
        },
        body: fromBase64Url(upload.ciphertext).buffer as ArrayBuffer,
      },
    )
    if (response.status !== 201 && response.status !== 204) {
      throw new Error(`attachment_upload_failed:${response.status}`)
    }
    assertManifestHeaders(response, upload.ref)
    await this.encrypted.markAttachmentUploaded(upload.ref.objectKey)
  }

  private async downloadAttachment(ref: EncryptedObjectRef): Promise<AttachmentUpload | null> {
    const response = await this.fetcher(
      `${this.baseUrl}/sync/v2/objects/${encodeURIComponent(ref.objectKey)}`,
      { headers: this.headers() },
    )
    if (response.status === 410) return null
    if (!response.ok) throw new Error(`attachment_download_failed:${response.status}`)
    assertManifestHeaders(response, ref)
    const ciphertext = new Uint8Array(await response.arrayBuffer())
    return { ref, ciphertext: base64Url(ciphertext), uploaded: true }
  }

  private async exchange(batch: EncryptedMutation[], cursor: string | null): Promise<ExchangeResponse> {
    const response = await this.fetcher(`${this.baseUrl}/sync/v2/exchange`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        protocolVersion: 2,
        envelopeVersion: 1,
        product: 'journal',
        deviceId: this.deviceId,
        cursor,
        mutations: batch,
      }),
    })
    if (!response.ok) throw new Error(`v2_exchange_failed:${response.status}`)
    return parseExchangeResponse(await response.json())
  }

  private async validateRemote(
    response: ExchangeResponse,
    downloaded: Map<string, AttachmentUpload>,
  ): Promise<void> {
    const validate = async (mutation: EncryptedMutation) => {
      if (mutation.operation === 'delete') return
      parsePayload(await decryptMutation(this.root, mutation), mutation.entityId, mutation.objects.length)
      for (const ref of mutation.objects) {
        const attachment = downloaded.get(ref.objectKey)
        if (attachment) await decryptAttachment(this.root, mutation, attachment)
      }
    }
    for (const change of response.changes) await validate(changeAsMutation(change))
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
      for (const mutation of batch) {
        for (const ref of mutation.objects) {
          state = await this.store.read()
          const attachment = state.attachments[ref.objectKey]
          if (!attachment) throw new Error('attachment_upload_state_missing')
          if (!attachment.uploaded) await this.uploadAttachment(attachment)
        }
      }
      state = await this.store.read()
      const response = await this.exchange(batch, state.cursor)
      const downloaded = new Map<string, AttachmentUpload>()
      for (const ref of refsForResponse(response)) {
        const cached = state.attachments[ref.objectKey]
        const attachment = cached && stableJson(cached.ref) === stableJson(ref)
          ? cached
          : await this.downloadAttachment(ref)
        if (attachment) downloaded.set(ref.objectKey, attachment)
      }
      await this.validateRemote(response, downloaded)
      await this.encrypted.applyExchange(
        response.acknowledged,
        response.conflicts,
        response.changes,
        response.nextCursor,
        [...downloaded.values()],
      )
      const next = await this.store.read()
      const progressed = response.acknowledged.length > 0 ||
        response.conflicts.some((conflict) => !conflict.retryable) ||
        response.changes.length > 0 ||
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
        mutation.objects.length,
      )
      let coverImage: string | undefined
      if (mutation.objects.length) {
        const attachment = state.attachments[mutation.objects[0].objectKey]
        if (!attachment || !payload.coverMediaType) throw new Error('attachment_restore_state_missing')
        coverImage = bytesToDataUrl(
          payload.coverMediaType,
          await decryptAttachment(this.root, mutation, attachment),
        )
      }
      entries[entityId] = {
        ...payload.entry,
        ...(coverImage ? { coverImage } : {}),
      }
    }
    return entries
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
    return desired
  }

  private async reconcile(desired: JournalEntries, initialState: SyncSnapshot): Promise<void> {
    let state = initialState
    let currentEntries = await this.materialize(state)
    const entityIds = new Set([...Object.keys(state.records), ...Object.keys(desired)])
    for (const entityId of entityIds) {
      const target = desired[entityId]
      const record = state.records[entityId]
      if (!target) {
        if (record && !record.deleted) {
          const mutation = await encryptMutation(this.root, {
            opId: crypto.randomUUID(),
            entityId,
            baseRevision: record.revision,
            operation: 'delete',
          }, null)
          await this.encrypted.queue(mutation)
          state = await this.store.read()
          delete currentEntries[entityId]
        }
        continue
      }
      const current = currentEntries[entityId]
      if (current && stableJson(payloadFromEntry(current)) === stableJson(payloadFromEntry(target))) continue
      const baseRevision = record?.revision ?? 0
      const mutation = await encryptMutation(this.root, {
        opId: crypto.randomUUID(),
        entityId,
        baseRevision,
        operation: 'upsert',
      }, payloadFromEntry(target))
      const attachments: AttachmentUpload[] = []
      if (target.coverImage) {
        const cover = parseDataUrl(target.coverImage)
        const attachment = await encryptAttachment(
          this.root,
          mutation,
          `journal_entry/${entityId}/${mutation.opId}/cover`,
          cover.bytes,
        )
        mutation.objects = [attachment.ref]
        attachments.push(attachment)
      }
      await this.encrypted.queue(mutation, attachments, target.updatedAt)
      state = await this.store.read()
      currentEntries[entityId] = target
    }
  }
}
