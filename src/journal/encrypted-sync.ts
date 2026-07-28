/**
 * Journal SyncEnvelope v1 cryptography and durable local state.
 *
 * Device credentials and the root key are deliberately outside SyncSnapshot.
 * A store implementation must commit each complete snapshot atomically.
 */
export type EncryptedObjectRef = {
  objectKey: string
  ciphertextSha256: string
  ciphertextBytes: number
  nonce: string
  aadHash: string
  keyVersion: number
}

export type EncryptedMutation = {
  opId: string
  entityType: 'journal_entry'
  entityId: string
  baseRevision: number
  operation: 'upsert' | 'delete'
  keyVersion: number
  ciphertext: string | null
  ciphertextSha256: string | null
  nonce: string | null
  aadHash: string
  objects: EncryptedObjectRef[]
}

export type EncryptedChange = Omit<EncryptedMutation, 'opId' | 'baseRevision'> & {
  revision: number
  changedAt: string
  originDeviceId: string
  operationId: string
}

export type EncryptedState = {
  entityType: 'journal_entry'
  entityId: string
  revision: number
  operation: 'upsert' | 'delete'
  keyVersion: number
  ciphertext: string | null
  ciphertextSha256: string | null
  nonce: string | null
  aadHash: string
  objects: EncryptedObjectRef[]
  deletedAt: string | null
  updatedAt: string
}

export type EncryptedConflict = {
  outcome: 'conflict'
  opId: string
  entityType: 'journal_entry'
  entityId: string
  operation: 'upsert' | 'delete'
  error: string
  retryable?: boolean
  current: EncryptedState | null
  candidate: EncryptedMutation | null
}

export type EncryptedAcknowledgement = {
  outcome: 'acknowledged'
  opId: string
  entityType: 'journal_entry'
  entityId: string
  operation: 'upsert' | 'delete'
  revision: number
  replayed?: boolean
}

export type SyncRecord = {
  revision: number
  deleted: boolean
  ciphertext: string | null
  ciphertextSha256: string | null
  nonce: string | null
  aadHash: string
  keyVersion: number
  objects: EncryptedObjectRef[]
  changedAt: string
  operationId: string | null
  conflicts: EncryptedConflict[]
}

export type AttachmentUpload = {
  ref: EncryptedObjectRef
  ciphertext: string
  uploaded: boolean
}

export type SyncSnapshot = {
  cursor: string | null
  records: Record<string, SyncRecord>
  outbox: EncryptedMutation[]
  attachments: Record<string, AttachmentUpload>
}

export interface SyncStore {
  read(): Promise<SyncSnapshot>
  /** Commit the complete snapshot atomically or reject without changing it. */
  write(snapshot: SyncSnapshot): Promise<void>
}

export type RootKeyBundle = { keyVersion: number; rawKey: string }

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const PLACEHOLDER_OPERATION_ID = '00000000-0000-4000-8000-000000000000'

export function emptySyncSnapshot(): SyncSnapshot {
  return { cursor: null, records: {}, outbox: [], attachments: {} }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_base64url')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  const hash = await crypto.subtle.digest('SHA-256', arrayBuffer(bytes))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function mutationAad(
  mutation: Pick<EncryptedMutation, 'entityType' | 'entityId' | 'baseRevision' | 'operation' | 'keyVersion'>,
) {
  return {
    envelopeVersion: 1,
    product: 'journal',
    entityType: mutation.entityType,
    entityId: mutation.entityId,
    operation: mutation.operation,
    keyVersion: mutation.keyVersion,
    revision: mutation.baseRevision + 1,
  }
}

function objectAad(mutation: EncryptedMutation, objectKey: string) {
  return { ...mutationAad(mutation), objectKey }
}

async function importRoot(bundle: RootKeyBundle): Promise<CryptoKey> {
  const key = fromBase64Url(bundle.rawKey)
  if (key.byteLength !== 32 || !Number.isSafeInteger(bundle.keyVersion) || bundle.keyVersion < 1) {
    throw new Error('invalid_root_key')
  }
  return crypto.subtle.importKey('raw', arrayBuffer(key), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function initializeRootKey(keyVersion = 1): Promise<RootKeyBundle> {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new Error('invalid_key_version')
  return { keyVersion, rawKey: base64Url(crypto.getRandomValues(new Uint8Array(32))) }
}

export function serializeRootKey(bundle: RootKeyBundle): string {
  if (!Number.isSafeInteger(bundle.keyVersion) || bundle.keyVersion < 1 || fromBase64Url(bundle.rawKey).byteLength !== 32) {
    throw new Error('invalid_root_key')
  }
  return `jk1.${bundle.keyVersion}.${bundle.rawKey}`
}

export function parseRootKey(value: string): RootKeyBundle | null {
  const match = /^jk1\.([1-9][0-9]*)\.([A-Za-z0-9_-]{43})$/.exec(value.trim())
  if (!match) return null
  const bundle = { keyVersion: Number(match[1]), rawKey: match[2] }
  try {
    return fromBase64Url(bundle.rawKey).byteLength === 32 ? bundle : null
  } catch {
    return null
  }
}

export async function encryptMutation(
  root: RootKeyBundle,
  input: Pick<EncryptedMutation, 'opId' | 'entityId' | 'baseRevision' | 'operation'>,
  payload: unknown,
): Promise<EncryptedMutation> {
  const mutation: EncryptedMutation = {
    ...input,
    entityType: 'journal_entry',
    keyVersion: root.keyVersion,
    ciphertext: null,
    ciphertextSha256: null,
    nonce: null,
    aadHash: '',
    objects: [],
  }
  const aad = stableJson(mutationAad(mutation))
  mutation.aadHash = await sha256(aad)
  if (mutation.operation === 'delete') return mutation
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: arrayBuffer(nonce),
      additionalData: arrayBuffer(encoder.encode(aad)),
    },
    await importRoot(root),
    arrayBuffer(encoder.encode(JSON.stringify(payload))),
  )
  mutation.nonce = base64Url(nonce)
  const encryptedBytes = new Uint8Array(encrypted)
  mutation.ciphertext = base64Url(encryptedBytes)
  mutation.ciphertextSha256 = await sha256(encryptedBytes)
  return mutation
}

export async function decryptMutation(root: RootKeyBundle, mutation: EncryptedMutation): Promise<unknown> {
  if (
    mutation.operation === 'delete' ||
    !mutation.ciphertext ||
    !mutation.ciphertextSha256 ||
    !mutation.nonce ||
    mutation.keyVersion !== root.keyVersion
  ) {
    throw new Error('undecryptable_mutation')
  }
  const encrypted = fromBase64Url(mutation.ciphertext)
  if (await sha256(encrypted) !== mutation.ciphertextSha256) throw new Error('ciphertext_hash_mismatch')
  const aad = stableJson(mutationAad(mutation))
  if (mutation.aadHash !== await sha256(aad)) throw new Error('aad_mismatch')
  const clear = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: arrayBuffer(fromBase64Url(mutation.nonce)),
      additionalData: arrayBuffer(encoder.encode(aad)),
    },
    await importRoot(root),
    arrayBuffer(encrypted),
  )
  return JSON.parse(decoder.decode(clear))
}

export async function encryptAttachment(
  root: RootKeyBundle,
  mutation: EncryptedMutation,
  objectKey: string,
  plain: Uint8Array,
): Promise<AttachmentUpload> {
  if (
    mutation.operation !== 'upsert' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/.test(objectKey) ||
    objectKey.includes('..') ||
    plain.byteLength < 1
  ) {
    throw new Error('invalid_attachment')
  }
  const aad = stableJson(objectAad(mutation, objectKey))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: arrayBuffer(nonce),
      additionalData: arrayBuffer(encoder.encode(aad)),
    },
    await importRoot(root),
    arrayBuffer(plain),
  ))
  const ref = {
    objectKey,
    ciphertextSha256: await sha256(ciphertext),
    ciphertextBytes: ciphertext.byteLength,
    nonce: base64Url(nonce),
    aadHash: await sha256(aad),
    keyVersion: root.keyVersion,
  }
  return { ref, ciphertext: base64Url(ciphertext), uploaded: false }
}

export async function decryptAttachment(
  root: RootKeyBundle,
  mutation: EncryptedMutation,
  upload: AttachmentUpload,
): Promise<Uint8Array> {
  const { ref } = upload
  const encrypted = fromBase64Url(upload.ciphertext)
  const aad = stableJson(objectAad(mutation, ref.objectKey))
  if (
    ref.keyVersion !== root.keyVersion ||
    encrypted.byteLength !== ref.ciphertextBytes ||
    await sha256(encrypted) !== ref.ciphertextSha256 ||
    ref.aadHash !== await sha256(aad)
  ) {
    throw new Error('attachment_integrity_failed')
  }
  const clear = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: arrayBuffer(fromBase64Url(ref.nonce)),
      additionalData: arrayBuffer(encoder.encode(aad)),
    },
    await importRoot(root),
    arrayBuffer(encrypted),
  )
  return new Uint8Array(clear)
}

export function mutationFromRecord(entityId: string, record: SyncRecord): EncryptedMutation {
  return {
    opId: record.operationId ?? PLACEHOLDER_OPERATION_ID,
    entityType: 'journal_entry',
    entityId,
    baseRevision: record.revision - 1,
    operation: record.deleted ? 'delete' : 'upsert',
    keyVersion: record.keyVersion,
    ciphertext: record.ciphertext,
    ciphertextSha256: record.ciphertextSha256,
    nonce: record.nonce,
    aadHash: record.aadHash,
    objects: clone(record.objects),
  }
}

function recordFromChange(change: EncryptedChange, conflicts: EncryptedConflict[]): SyncRecord {
  return {
    revision: change.revision,
    deleted: change.operation === 'delete',
    ciphertext: change.ciphertext,
    ciphertextSha256: change.ciphertextSha256,
    nonce: change.nonce,
    aadHash: change.aadHash,
    keyVersion: change.keyVersion,
    objects: clone(change.objects),
    changedAt: change.changedAt,
    operationId: change.operationId,
    conflicts,
  }
}

function recordFromState(state: EncryptedState, conflicts: EncryptedConflict[]): SyncRecord {
  return {
    revision: state.revision,
    deleted: state.operation === 'delete',
    ciphertext: state.ciphertext,
    ciphertextSha256: state.ciphertextSha256,
    nonce: state.nonce,
    aadHash: state.aadHash,
    keyVersion: state.keyVersion,
    objects: clone(state.objects),
    changedAt: state.updatedAt,
    operationId: null,
    conflicts,
  }
}

export class JournalEncryptedSync {
  private readonly store: SyncStore

  constructor(store: SyncStore) {
    this.store = store
  }

  async queue(
    mutation: EncryptedMutation,
    attachments: AttachmentUpload[] = [],
    changedAt = new Date().toISOString(),
  ): Promise<void> {
    const state = clone(await this.store.read())
    if (state.outbox.some((item) => item.opId === mutation.opId)) throw new Error('duplicate_op_id')
    for (const attachment of attachments) state.attachments[attachment.ref.objectKey] = clone(attachment)
    const existing = state.records[mutation.entityId]
    state.records[mutation.entityId] = {
      revision: mutation.baseRevision + 1,
      deleted: mutation.operation === 'delete',
      ciphertext: mutation.ciphertext,
      ciphertextSha256: mutation.ciphertextSha256,
      nonce: mutation.nonce,
      aadHash: mutation.aadHash,
      keyVersion: mutation.keyVersion,
      objects: clone(mutation.objects),
      changedAt,
      operationId: mutation.opId,
      conflicts: existing?.conflicts ?? [],
    }
    state.outbox.push(clone(mutation))
    await this.store.write(state)
  }

  async markAttachmentUploaded(objectKey: string): Promise<void> {
    const state = clone(await this.store.read())
    const attachment = state.attachments[objectKey]
    if (!attachment) throw new Error('attachment_missing')
    attachment.uploaded = true
    await this.store.write(state)
  }

  /** Persist downloads, conflict evidence, materialization, cursor and ACK removal together. */
  async applyExchange(
    acknowledged: EncryptedAcknowledgement[],
    conflicts: EncryptedConflict[],
    changes: EncryptedChange[],
    nextCursor: string,
    downloadedAttachments: AttachmentUpload[] = [],
  ): Promise<void> {
    if (!/^c[0-9a-z]+$/.test(nextCursor)) throw new Error('invalid_cursor')
    const state = clone(await this.store.read())
    const queuedById = new Map(state.outbox.map((mutation) => [mutation.opId, mutation]))
    for (const attachment of downloadedAttachments) {
      state.attachments[attachment.ref.objectKey] = { ...clone(attachment), uploaded: true }
    }

    const completedConflicts = new Set<string>()
    for (const conflict of conflicts) {
      const queued = queuedById.get(conflict.opId)
      const retainedConflict = {
        ...clone(conflict),
        candidate: conflict.candidate ?? (queued ? clone(queued) : null),
      }
      const existing = state.records[conflict.entityId]
      const retained = (existing?.conflicts ?? []).some(
        (item) => item.opId === conflict.opId && item.error === conflict.error,
      )
        ? existing?.conflicts ?? []
        : [...(existing?.conflicts ?? []), retainedConflict]
      if (conflict.current) state.records[conflict.entityId] = recordFromState(conflict.current, retained)
      else if (existing) existing.conflicts = retained
      if (!conflict.retryable) completedConflicts.add(conflict.opId)
    }

    for (const change of changes) {
      const current = state.records[change.entityId]
      if (current && change.revision < current.revision) continue
      if (
        current &&
        change.revision === current.revision &&
        (
          current.deleted !== (change.operation === 'delete') ||
          current.aadHash !== change.aadHash ||
          current.ciphertext !== change.ciphertext ||
          current.ciphertextSha256 !== change.ciphertextSha256 ||
          current.nonce !== change.nonce ||
          current.keyVersion !== change.keyVersion ||
          stableJson(current.objects) !== stableJson(change.objects)
        )
      ) {
        const divergence: EncryptedConflict = {
          outcome: 'conflict',
          opId: change.operationId,
          entityType: 'journal_entry',
          entityId: change.entityId,
          operation: change.operation,
          error: 'EQUAL_REVISION_DIVERGENCE',
          current: null,
          candidate: {
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
            objects: clone(change.objects),
          },
        }
        if (!current.conflicts.some(
          (item) => item.opId === divergence.opId && item.error === divergence.error,
        )) current.conflicts.push(divergence)
        continue
      }
      if (current?.deleted && change.operation === 'upsert' && change.revision <= current.revision) continue
      state.records[change.entityId] = recordFromChange(change, current?.conflicts ?? [])
    }

    const acknowledgedIds = new Set<string>()
    for (const acknowledgement of acknowledged) {
      const queued = queuedById.get(acknowledgement.opId)
      if (
        !queued ||
        queued.entityId !== acknowledgement.entityId ||
        queued.entityType !== acknowledgement.entityType ||
        queued.operation !== acknowledgement.operation ||
        queued.baseRevision + 1 !== acknowledgement.revision
      ) {
        throw new Error('unexpected_acknowledgement')
      }
      acknowledgedIds.add(acknowledgement.opId)
    }
    state.outbox = state.outbox.filter(
      (item) => !acknowledgedIds.has(item.opId) && !completedConflicts.has(item.opId),
    )
    state.cursor = nextCursor
    await this.store.write(state)
  }
}
