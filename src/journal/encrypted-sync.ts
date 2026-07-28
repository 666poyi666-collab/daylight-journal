/**
 * Local Journal SyncEnvelope v1 data plane.
 *
 * This module deliberately has no OAuth or browser UI dependency. Callers keep
 * device credentials outside this store; only encrypted payloads, immutable
 * operation IDs and resumable attachment uploads are persisted here.
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

export type SyncRecord = {
  revision: number
  deleted: boolean
  ciphertext: string | null
  nonce: string | null
  aadHash: string
  keyVersion: number
  objects: EncryptedObjectRef[]
  conflicts: EncryptedChange[]
}

export type AttachmentUpload = { ref: EncryptedObjectRef; ciphertext: string; uploaded: boolean }
export type SyncSnapshot = {
  cursor: string | null
  records: Record<string, SyncRecord>
  outbox: EncryptedMutation[]
  attachments: Record<string, AttachmentUpload>
}

export interface SyncStore {
  read(): Promise<SyncSnapshot>
  /** Implementations must commit the complete snapshot atomically. */
  write(snapshot: SyncSnapshot): Promise<void>
}

export type RootKeyBundle = { keyVersion: number; rawKey: string }
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_base64url')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}
function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}
async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', arrayBuffer(bytes))), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
function mutationAad(mutation: Pick<EncryptedMutation, 'entityType' | 'entityId' | 'baseRevision' | 'operation' | 'keyVersion'>) {
  return { envelopeVersion: 1, product: 'journal', entityType: mutation.entityType, entityId: mutation.entityId, operation: mutation.operation, keyVersion: mutation.keyVersion, revision: mutation.baseRevision + 1 }
}
function objectAad(mutation: EncryptedMutation, objectKey: string) { return { ...mutationAad(mutation), objectKey } }
async function importRoot(bundle: RootKeyBundle): Promise<CryptoKey> {
  const key = fromBase64Url(bundle.rawKey)
  if (key.byteLength !== 32 || !Number.isSafeInteger(bundle.keyVersion) || bundle.keyVersion < 1) throw new Error('invalid_root_key')
  return crypto.subtle.importKey('raw', arrayBuffer(key), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function initializeRootKey(keyVersion = 1): Promise<RootKeyBundle> {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new Error('invalid_key_version')
  const raw = crypto.getRandomValues(new Uint8Array(32))
  return { keyVersion, rawKey: base64Url(raw) }
}

export async function encryptMutation(
  root: RootKeyBundle,
  input: Pick<EncryptedMutation, 'opId' | 'entityId' | 'baseRevision' | 'operation'>,
  payload: unknown,
): Promise<EncryptedMutation> {
  const mutation: EncryptedMutation = { ...input, entityType: 'journal_entry', keyVersion: root.keyVersion, ciphertext: null, nonce: null, aadHash: '', objects: [] }
  mutation.aadHash = await digest(stableJson(mutationAad(mutation)))
  if (mutation.operation === 'delete') return mutation
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: arrayBuffer(nonce), additionalData: arrayBuffer(encoder.encode(stableJson(mutationAad(mutation))) as Uint8Array) }, await importRoot(root), arrayBuffer(encoder.encode(JSON.stringify(payload)) as Uint8Array))
  mutation.nonce = base64Url(nonce)
  mutation.ciphertext = base64Url(new Uint8Array(encrypted))
  return mutation
}

export async function decryptMutation(root: RootKeyBundle, mutation: EncryptedMutation): Promise<unknown> {
  if (mutation.operation === 'delete' || !mutation.ciphertext || !mutation.nonce || mutation.keyVersion !== root.keyVersion) throw new Error('undecryptable_mutation')
  if (mutation.aadHash !== await digest(stableJson(mutationAad(mutation)))) throw new Error('aad_mismatch')
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: arrayBuffer(fromBase64Url(mutation.nonce)), additionalData: arrayBuffer(encoder.encode(stableJson(mutationAad(mutation)) ) as Uint8Array) }, await importRoot(root), arrayBuffer(fromBase64Url(mutation.ciphertext)))
  return JSON.parse(decoder.decode(clear))
}

export async function encryptAttachment(root: RootKeyBundle, mutation: EncryptedMutation, objectKey: string, plain: Uint8Array): Promise<AttachmentUpload> {
  if (mutation.operation !== 'upsert' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/.test(objectKey) || objectKey.includes('..')) throw new Error('invalid_attachment')
  const aad = stableJson(objectAad(mutation, objectKey))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: arrayBuffer(nonce), additionalData: arrayBuffer(encoder.encode(aad) as Uint8Array) }, await importRoot(root), arrayBuffer(plain)))
  const ref = { objectKey, ciphertextSha256: await digest(ciphertext), ciphertextBytes: ciphertext.byteLength, nonce: base64Url(nonce), aadHash: await digest(aad), keyVersion: root.keyVersion }
  return { ref, ciphertext: base64Url(ciphertext), uploaded: false }
}

export async function decryptAttachment(root: RootKeyBundle, mutation: EncryptedMutation, upload: AttachmentUpload): Promise<Uint8Array> {
  const { ref } = upload
  const encrypted = fromBase64Url(upload.ciphertext)
  if (ref.keyVersion !== root.keyVersion || encrypted.byteLength !== ref.ciphertextBytes || await digest(encrypted) !== ref.ciphertextSha256 || ref.aadHash !== await digest(stableJson(objectAad(mutation, ref.objectKey)))) throw new Error('attachment_integrity_failed')
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: arrayBuffer(fromBase64Url(ref.nonce)), additionalData: arrayBuffer(encoder.encode(stableJson(objectAad(mutation, ref.objectKey))) as Uint8Array) }, await importRoot(root), arrayBuffer(encrypted))
  return new Uint8Array(clear)
}

export class JournalEncryptedSync {
  private readonly store: SyncStore
  constructor(store: SyncStore) { this.store = store }

  async queue(mutation: EncryptedMutation, attachments: AttachmentUpload[] = []): Promise<void> {
    const state = clone(await this.store.read())
    if (state.outbox.some((item) => item.opId === mutation.opId)) throw new Error('duplicate_op_id')
    for (const attachment of attachments) state.attachments[attachment.ref.objectKey] = attachment
    const existing = state.records[mutation.entityId]
    state.records[mutation.entityId] = {
      revision: mutation.baseRevision + 1,
      deleted: mutation.operation === 'delete',
      ciphertext: mutation.ciphertext,
      nonce: mutation.nonce,
      aadHash: mutation.aadHash,
      keyVersion: mutation.keyVersion,
      objects: clone(mutation.objects),
      conflicts: existing?.conflicts ?? [],
    }
    state.outbox.push(clone(mutation))
    await this.store.write(state)
  }

  async markAttachmentUploaded(objectKey: string): Promise<void> {
    const state = clone(await this.store.read()); const attachment = state.attachments[objectKey]
    if (!attachment) throw new Error('attachment_missing')
    attachment.uploaded = true; await this.store.write(state)
  }

  /** Materializes remote changes, advances cursor and removes acknowledged work in one commit. */
  async applyExchange(acknowledged: Array<{ opId: string; revision: number }>, changes: EncryptedChange[], nextCursor: string): Promise<void> {
    if (!/^c[0-9a-z]+$/.test(nextCursor)) throw new Error('invalid_cursor')
    const state = clone(await this.store.read())
    for (const change of changes) {
      const current = state.records[change.entityId]
      if (current && change.revision < current.revision) continue
      if (current && change.revision === current.revision && (current.aadHash !== change.aadHash || current.ciphertext !== change.ciphertext)) {
        current.conflicts.push(change); continue
      }
      if (current?.deleted && change.operation === 'upsert' && change.revision <= current.revision) continue
      state.records[change.entityId] = { revision: change.revision, deleted: change.operation === 'delete', ciphertext: change.ciphertext, nonce: change.nonce, aadHash: change.aadHash, keyVersion: change.keyVersion, objects: change.objects, conflicts: current?.conflicts ?? [] }
    }
    const acked = new Map(acknowledged.map((item) => [item.opId, item.revision]))
    state.outbox = state.outbox.filter((item) => !acked.has(item.opId))
    state.cursor = nextCursor
    await this.store.write(state)
  }
}
