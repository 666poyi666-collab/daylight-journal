/**
 * 应用锁：4–6 位数字密码，PBKDF2-SHA256 加盐哈希后只存本机。
 *
 * 这是一道防翻看的门，不是对日记数据的加密——本地 localStorage 和同步服务端
 * 仍以明文保存正文（MCP 复盘链路需要读取原文）。因此忘记密码不提供应用内重置：
 * 若允许绕过，这道门就形同虚设；清除应用数据后界面可恢复，已同步日记仍在服务端。
 */

export interface LockRecord {
  v: 1
  salt: string
  hash: string
  iterations: number
  length: number
  createdAt: string
}

export const LOCK_STORAGE_KEY = 'daylight-journal-lock-v1'
const PBKDF2_ITERATIONS = 120_000

const textEncoder = new TextEncoder()

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function isPinFormat(pin: string): boolean {
  return /^\d{4,6}$/.test(pin)
}

export function isLockSupported(): boolean {
  return Boolean(globalThis.crypto?.subtle)
}

async function derivePinHash(
  pin: string,
  salt: Uint8Array,
  iterations: number,
): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  )
  return bytesToBase64(new Uint8Array(bits))
}

export async function createLockRecord(pin: string): Promise<LockRecord> {
  if (!isPinFormat(pin)) throw new Error('PIN must be 4-6 digits')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return {
    v: 1,
    salt: bytesToBase64(salt),
    hash: await derivePinHash(pin, salt, PBKDF2_ITERATIONS),
    iterations: PBKDF2_ITERATIONS,
    length: pin.length,
    createdAt: new Date().toISOString(),
  }
}

export async function verifyPin(
  record: LockRecord,
  pin: string,
): Promise<boolean> {
  if (!isPinFormat(pin) || pin.length !== record.length) return false
  try {
    const hash = await derivePinHash(
      pin,
      base64ToBytes(record.salt),
      record.iterations,
    )
    if (hash.length !== record.hash.length) return false
    // 恒定时间比较，避免早退泄露前缀匹配长度。
    let difference = 0
    for (let index = 0; index < hash.length; index += 1) {
      difference |= hash.charCodeAt(index) ^ record.hash.charCodeAt(index)
    }
    return difference === 0
  } catch {
    return false
  }
}

export function decodeLockRecord(raw: string | null): LockRecord | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as LockRecord
    if (
      value?.v === 1 &&
      typeof value.salt === 'string' &&
      typeof value.hash === 'string' &&
      Number.isInteger(value.iterations) &&
      value.iterations >= 10_000 &&
      Number.isInteger(value.length) &&
      value.length >= 4 &&
      value.length <= 6
    ) {
      return value
    }
    return null
  } catch {
    return null
  }
}
