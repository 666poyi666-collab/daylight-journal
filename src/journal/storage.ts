import {
  decodeJournalEntries,
  type JournalEntries,
} from './model.ts'

export const STORAGE_KEY = 'daylight-journal-entries-v1'
export const STORAGE_RECOVERY_KEY = 'daylight-journal-entries-recovery-v1'
export const SETTINGS_KEY = 'daylight-journal-settings-v1'

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
export type StorageIssue = 'unavailable' | 'quota' | 'corrupt' | 'invalid-data'

export type LoadEntriesResult = {
  entries: JournalEntries
  issue: StorageIssue | null
  raw: string | null
}

export type PersistResult =
  | { ok: true }
  | { ok: false; issue: Exclude<StorageIssue, 'corrupt' | 'invalid-data'> }

function classifyWriteError(error: unknown): 'quota' | 'unavailable' {
  if (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  ) {
    return 'quota'
  }
  return 'unavailable'
}

/** Return browser storage when accessible; privacy modes may throw on access. */
export function getBrowserStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readStorageValue(
  key: string,
  storage = getBrowserStorage(),
): string | null {
  if (!storage) return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

export function writeStorageValue(
  key: string,
  value: string,
  storage = getBrowserStorage(),
): PersistResult {
  if (!storage) return { ok: false, issue: 'unavailable' }
  try {
    storage.setItem(key, value)
    return { ok: true }
  } catch (error) {
    return { ok: false, issue: classifyWriteError(error) }
  }
}

/** Load and validate journal data while preserving the raw value for recovery. */
export function loadJournalEntries(
  storage = getBrowserStorage(),
): LoadEntriesResult {
  if (!storage) return { entries: {}, issue: 'unavailable', raw: null }

  let raw: string | null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return { entries: {}, issue: 'unavailable', raw: null }
  }
  if (!raw) return { entries: {}, issue: null, raw: null }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { entries: {}, issue: 'corrupt', raw }
  }

  const decoded = decodeJournalEntries(value)
  const issue = decoded.invalidRoot || decoded.invalidKeys.length
    ? 'invalid-data'
    : null
  return { entries: decoded.entries, issue, raw }
}

/** Persist a complete journal snapshot. Failure is reported and never thrown. */
export function persistJournalEntries(
  entries: JournalEntries,
  storage = getBrowserStorage(),
): PersistResult {
  return writeStorageValue(STORAGE_KEY, JSON.stringify(entries), storage)
}

/** Preserve malformed input before a later valid snapshot replaces the main key. */
export function preserveRecoveryValue(
  raw: string,
  storage = getBrowserStorage(),
): PersistResult {
  return writeStorageValue(STORAGE_RECOVERY_KEY, raw, storage)
}
