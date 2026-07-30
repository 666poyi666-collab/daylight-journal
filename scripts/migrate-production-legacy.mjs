import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseRootKey } from '../src/journal/encrypted-sync.ts'
import {
  BrowserSyncStore,
  JournalV2SyncClient,
  deviceIdFromToken,
} from '../src/journal/v2-sync.ts'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const productionBaseUrl = 'https://journal-mcp.focuslink-poyi-6465e9.workers.dev'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function externalAbsolutePath(value, name) {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  const path = resolve(value)
  if (!relative(repositoryRoot, path).startsWith('..')) {
    throw new Error(`${name} must stay outside the repository`)
  }
  return path
}

class FileStorage {
  constructor(path) {
    this.path = path
    this.values = existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf8'))
      : {}
  }

  getItem(key) {
    return typeof this.values[key] === 'string' ? this.values[key] : null
  }

  setItem(key, value) {
    this.values[key] = value
    const temporaryPath = `${this.path}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(this.values, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporaryPath, this.path)
  }
}

const credentialsPath = externalAbsolutePath(argument('--credentials'), '--credentials')
const statePath = externalAbsolutePath(argument('--state'), '--state')
const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'))
const rootKey = parseRootKey(credentials?.rootKey ?? '')
const deviceToken = credentials?.devices?.pc?.deviceToken
if (
  credentials?.baseUrl !== productionBaseUrl ||
  !rootKey ||
  typeof deviceToken !== 'string' ||
  deviceIdFromToken(deviceToken) !== 'journal-pc-primary'
) {
  throw new Error('invalid production device credentials')
}

const storage = new FileStorage(statePath)
const store = new BrowserSyncStore(
  storage,
  productionBaseUrl,
  'journal-pc-primary',
)
const client = new JournalV2SyncClient({
  baseUrl: productionBaseUrl,
  deviceToken,
  rootKey,
  store,
})
const first = await client.synchronize({})
const second = await client.synchronize(first.entries)
const state = await store.read()

process.stdout.write(`${JSON.stringify({
  entries: Object.keys(second.entries).length,
  conflictCount: second.conflictCount,
  records: Object.keys(state.records).length,
  outbox: state.outbox.length,
  pendingLegacyImports: state.pendingLegacyImports.length,
  legacyHasMore: state.legacyHasMore,
  idempotentSecondPass: Object.keys(first.entries).length === Object.keys(second.entries).length,
})}\n`)
