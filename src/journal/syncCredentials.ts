type NativeSecureStorage = {
  get: (input: { key: string }) => Promise<{ value?: string }>
  set: (input: { key: string; value: string }) => Promise<void>
  remove?: (input: { key: string }) => Promise<void>
}

type CredentialRecord = {
  key: 'credential-v1'
  endpoint: string
  ciphertext: string
  nonce: string
}

type VaultKeyRecord = {
  key: 'vault-key-v1'
  value: CryptoKey
}

export type JournalSyncCredential = {
  endpoint: string
  deviceToken: string
  storage: 'native-secure-storage' | 'device-bound-vault'
}

const DATABASE_NAME = 'daylight-journal-sync-credentials-v1'
const DATABASE_VERSION = 1
const KEY_STORE = 'keys'
const CREDENTIAL_STORE = 'credentials'
const NATIVE_TOKEN_KEY = 'daylight-journal-device-token-v1'
const AAD_SCOPE = 'daylight-journal-device-token-v1'
const DEVICE_TOKEN_PATTERN = /^dj1\.[A-Za-z0-9][A-Za-z0-9_-]{2,127}\.[A-Za-z0-9_-]{32,512}$/
const MAX_CIPHERTEXT_CHARS = 2_048

let databasePromise: Promise<IDBDatabase> | null = null
let vaultKeyPromise: Promise<CryptoKey> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  return parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
}

export function isJournalDeviceToken(value: string): boolean {
  return DEVICE_TOKEN_PATTERN.test(value)
}

/** HTTPS is accepted globally; plaintext is limited to fixed Journal ports on trusted local names/ranges. */
export function normalizeJournalSyncEndpoint(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.username || url.password || url.search || url.hash) return null
    if (url.protocol === 'http:') {
      const localHost = url.hostname === 'localhost' || url.hostname === '[::1]' ||
        url.hostname.endsWith('.local') || isPrivateIpv4(url.hostname)
      if (!localHost || !['8780', '8781'].includes(url.port)) return null
    } else if (url.protocol !== 'https:') {
      return null
    }
    return url.href.replace(/\/$/, '')
  } catch {
    return null
  }
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
    throw new Error('Invalid credential vault encoding')
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
  if (base64Url(decoded) !== value) throw new Error('Invalid credential vault encoding')
  return decoded
}

function isVaultKey(value: unknown): value is CryptoKey {
  if (!value || typeof value !== 'object') return false
  const candidate = value as CryptoKey
  return candidate.type === 'secret' && candidate.extractable === false &&
    candidate.algorithm?.name === 'AES-GCM' && candidate.usages.includes('encrypt') &&
    candidate.usages.includes('decrypt')
}

function isCredentialRecord(value: unknown): value is CredentialRecord {
  if (!isRecord(value) || value.key !== 'credential-v1' || typeof value.endpoint !== 'string' ||
    normalizeJournalSyncEndpoint(value.endpoint) !== value.endpoint || typeof value.ciphertext !== 'string' ||
    typeof value.nonce !== 'string' || value.ciphertext.length > MAX_CIPHERTEXT_CHARS) return false
  if (value.ciphertext === '' || value.nonce === '') return value.ciphertext === '' && value.nonce === ''
  try {
    return decodeBase64Url(value.nonce).byteLength === 12 && decodeBase64Url(value.ciphertext).byteLength >= 16
  } catch {
    return false
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Credential vault request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Credential vault transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Credential vault transaction was aborted'))
  })
}

async function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  if (typeof indexedDB === 'undefined') throw new Error('Secure credential storage is unavailable')
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onerror = () => reject(request.error ?? new Error('Credential vault could not open'))
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(KEY_STORE)) database.createObjectStore(KEY_STORE, { keyPath: 'key' })
      if (!database.objectStoreNames.contains(CREDENTIAL_STORE)) database.createObjectStore(CREDENTIAL_STORE, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
  })
  return databasePromise
}

async function loadOrCreateVaultKey(): Promise<CryptoKey> {
  const database = await openDatabase()
  const read = database.transaction(KEY_STORE, 'readonly')
  const existing = await requestResult(read.objectStore(KEY_STORE).get('vault-key-v1')) as unknown
  await transactionDone(read)
  if (existing !== undefined) {
    if (!isRecord(existing) || existing.key !== 'vault-key-v1' || !isVaultKey(existing.value)) {
      throw new Error('Credential vault key record is invalid')
    }
    return existing.value
  }

  const generated = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const write = database.transaction(KEY_STORE, 'readwrite')
  try {
    await requestResult(
      write.objectStore(KEY_STORE).add({ key: 'vault-key-v1', value: generated } satisfies VaultKeyRecord),
    )
    await transactionDone(write)
    return generated
  } catch {
    const retry = database.transaction(KEY_STORE, 'readonly')
    const winner = await requestResult(retry.objectStore(KEY_STORE).get('vault-key-v1')) as unknown
    await transactionDone(retry)
    if (!isRecord(winner) || winner.key !== 'vault-key-v1' || !isVaultKey(winner.value)) {
      throw new Error('Credential vault key could not be created safely')
    }
    return winner.value
  }
}

async function vaultKey(): Promise<CryptoKey> {
  vaultKeyPromise ??= loadOrCreateVaultKey()
  try {
    return await vaultKeyPromise
  } catch (error) {
    vaultKeyPromise = null
    throw error
  }
}

function secureStorage(): NativeSecureStorage | null {
  const candidate = (window as Window & {
    Capacitor?: { Plugins?: Record<string, unknown>; isNativePlatform?: () => boolean }
  }).Capacitor
  if (!candidate?.isNativePlatform?.()) return null
  const plugin = candidate.Plugins?.SecureStorage
  if (!plugin || typeof plugin !== 'object') return null
  const value = plugin as Partial<NativeSecureStorage>
  return typeof value.get === 'function' && typeof value.set === 'function'
    ? value as NativeSecureStorage
    : null
}

function aad(endpoint: string): Uint8Array {
  return utf8(JSON.stringify({ scope: AAD_SCOPE, endpoint }))
}

async function encryptToken(endpoint: string, token: string): Promise<Pick<CredentialRecord, 'ciphertext' | 'nonce'>> {
  const nonce = new Uint8Array(12)
  crypto.getRandomValues(nonce)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aad(endpoint)) },
    await vaultKey(),
    asArrayBuffer(utf8(token)),
  )
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), nonce: base64Url(nonce) }
}

async function decryptToken(record: CredentialRecord): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: asArrayBuffer(decodeBase64Url(record.nonce)),
      additionalData: asArrayBuffer(aad(record.endpoint)),
    },
    await vaultKey(),
    asArrayBuffer(decodeBase64Url(record.ciphertext)),
  )
  return new TextDecoder().decode(plain)
}

export async function loadJournalSyncCredential(): Promise<JournalSyncCredential | null> {
  const database = await openDatabase()
  const transaction = database.transaction(CREDENTIAL_STORE, 'readonly')
  const stored = await requestResult(transaction.objectStore(CREDENTIAL_STORE).get('credential-v1')) as unknown
  await transactionDone(transaction)
  if (stored === undefined) return null
  if (!isCredentialRecord(stored)) throw new Error('Stored Journal device credential is invalid')
  const record = stored

  const native = secureStorage()
  if (native) {
    if (record.ciphertext !== '' || record.nonce !== '') {
      throw new Error('Native Journal credential record has an invalid storage marker')
    }
    try {
      const response = await native.get({ key: NATIVE_TOKEN_KEY })
      if (typeof response.value === 'string' && isJournalDeviceToken(response.value)) {
        return { endpoint: record.endpoint, deviceToken: response.value, storage: 'native-secure-storage' }
      }
    } catch {
      // A native plugin failure must not silently expose a plaintext fallback.
      return null
    }
  }
  if (record.ciphertext === '' || record.nonce === '') return null
  try {
    const deviceToken = await decryptToken(record)
    return isJournalDeviceToken(deviceToken)
      ? { endpoint: record.endpoint, deviceToken, storage: 'device-bound-vault' }
      : null
  } catch {
    return null
  }
}

/** Persist a device credential without ever placing it in localStorage or a URL. */
export async function saveJournalSyncCredential(
  endpoint: string,
  deviceToken: string,
): Promise<JournalSyncCredential> {
  const normalizedEndpoint = normalizeJournalSyncEndpoint(endpoint)
  if (!normalizedEndpoint || !isJournalDeviceToken(deviceToken)) {
    throw new Error('Invalid Journal device credential')
  }
  const database = await openDatabase()
  const native = secureStorage()
  let record: CredentialRecord
  let storage: JournalSyncCredential['storage']
  let previousNativeValue: string | undefined
  if (native) {
    try {
      previousNativeValue = (await native.get({ key: NATIVE_TOKEN_KEY })).value
    } catch {
      throw new Error('Native secure credential storage is unavailable')
    }
    await native.set({ key: NATIVE_TOKEN_KEY, value: deviceToken })
    record = { key: 'credential-v1', endpoint: normalizedEndpoint, ciphertext: '', nonce: '' }
    storage = 'native-secure-storage'
  } else {
    record = {
      key: 'credential-v1',
      endpoint: normalizedEndpoint,
      ...(await encryptToken(normalizedEndpoint, deviceToken)),
    }
    storage = 'device-bound-vault'
  }
  try {
    const transaction = database.transaction(CREDENTIAL_STORE, 'readwrite')
    transaction.objectStore(CREDENTIAL_STORE).put(record)
    await transactionDone(transaction)
  } catch (error) {
    if (native) {
      try {
        if (typeof previousNativeValue === 'string') {
          await native.set({ key: NATIVE_TOKEN_KEY, value: previousNativeValue })
        } else if (native.remove) {
          await native.remove({ key: NATIVE_TOKEN_KEY })
        }
      } catch {
        // The original database error remains the actionable failure.
      }
    }
    throw error
  }
  return { endpoint: normalizedEndpoint, deviceToken, storage }
}

export async function clearJournalSyncCredential(): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(CREDENTIAL_STORE, 'readwrite')
  transaction.objectStore(CREDENTIAL_STORE).delete('credential-v1')
  await transactionDone(transaction)
  const native = secureStorage()
  if (native?.remove) await native.remove({ key: NATIVE_TOKEN_KEY })
}

/** Remove the pre-V2 plaintext location after the secure vault has loaded it once. */
export function removeLegacyJournalSyncToken(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Browser storage may be disabled. The legacy token then remains inaccessible to this app.
  }
}
