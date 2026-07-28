import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import test from 'node:test'
import {
  decryptMutation,
  emptySyncSnapshot,
  initializeRootKey,
  type EncryptedChange,
  type EncryptedMutation,
  type EncryptedObjectRef,
  type SyncSnapshot,
  type SyncStore,
} from '../src/journal/encrypted-sync.ts'
import { type JournalEntries, type JournalEntry } from '../src/journal/model.ts'
import { BrowserSyncStore, JournalV2SyncClient, deviceIdFromToken } from '../src/journal/v2-sync.ts'

type StoredObject = {
  body: Buffer
  ref: EncryptedObjectRef
  entityId: string
  tombstoned: boolean
}

type SequencedChange = EncryptedChange & { sequence: number }

class MemoryStore implements SyncStore {
  value = emptySyncSnapshot()

  async read(): Promise<SyncSnapshot> {
    return structuredClone(this.value)
  }

  async write(value: SyncSnapshot): Promise<void> {
    this.value = structuredClone(value)
  }
}

class V2Authority {
  readonly requests: Array<{ method: string; path: string; body: string }> = []
  readonly objects = new Map<string, StoredObject>()
  readonly entities = new Map<string, SequencedChange>()
  readonly operations = new Map<string, { request: string; acknowledgement: Record<string, unknown> }>()
  readonly changes: SequencedChange[] = []
  readonly deviceTokens = new Map<string, string>()
  fallbackCalls = 0
  objectRouteCalls = 0
  failNextExchange = false
  private server = createServer((request, response) => void this.handle(request, response))

  approve(deviceId: string, secretCharacter: string): string {
    const token = `dj1.${deviceId}.${secretCharacter.repeat(43)}`
    this.deviceTokens.set(deviceId, token)
    return token
  }

  async start(): Promise<string> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => resolvePromise())
    })
    const address = this.server.address()
    assert.ok(address && typeof address !== 'string')
    return `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    this.server.closeIdleConnections()
    this.server.closeAllConnections()
    await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()))
  }

  private async body(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }

  private authenticated(request: IncomingMessage, deviceId: string): boolean {
    return request.headers.authorization === `Bearer ${this.deviceTokens.get(deviceId)}` &&
      request.headers['x-journal-device-id'] === deviceId
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(value))
  }

  private manifestHeaders(ref: EncryptedObjectRef): Record<string, string> {
    return {
      'X-Ciphertext-Sha256': ref.ciphertextSha256,
      'X-Ciphertext-Bytes': String(ref.ciphertextBytes),
      'X-Object-Nonce': ref.nonce,
      'X-Object-Aad-Hash': ref.aadHash,
      'X-Key-Version': String(ref.keyVersion),
    }
  }

  private readManifest(request: IncomingMessage, objectKey: string): EncryptedObjectRef {
    return {
      objectKey,
      ciphertextSha256: String(request.headers['x-ciphertext-sha256']),
      ciphertextBytes: Number(request.headers['x-ciphertext-bytes']),
      nonce: String(request.headers['x-object-nonce']),
      aadHash: String(request.headers['x-object-aad-hash']),
      keyVersion: Number(request.headers['x-key-version']),
    }
  }

  private currentState(entityId: string): Record<string, unknown> | null {
    const current = this.entities.get(entityId)
    if (!current) return null
    return {
      entityType: current.entityType,
      entityId: current.entityId,
      revision: current.revision,
      operation: current.operation,
      keyVersion: current.keyVersion,
      ciphertext: current.ciphertext,
      ciphertextSha256: current.ciphertextSha256,
      nonce: current.nonce,
      aadHash: current.aadHash,
      objects: current.objects,
      deletedAt: current.operation === 'delete' ? current.changedAt : null,
      updatedAt: current.changedAt,
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://journal-client.test')
    if (url.pathname.startsWith('/sync/v1/') || url.pathname.startsWith('/journal/') || url.pathname === '/sync/push') {
      this.fallbackCalls += 1
      this.json(response, 200, { bait: 'legacy route must never be called' })
      return
    }

    if (url.pathname.startsWith('/sync/v2/objects/')) {
      this.objectRouteCalls += 1
      const objectKey = decodeURIComponent(url.pathname.slice('/sync/v2/objects/'.length))
      const parts = objectKey.split('/')
      const entityId = parts[1] ?? ''
      const deviceId = String(request.headers['x-journal-device-id'] ?? '')
      if (!this.authenticated(request, deviceId)) {
        this.json(response, 401, { error: 'unauthorized' })
        return
      }
      if (method === 'PUT') {
        const body = await this.body(request)
        const ref = this.readManifest(request, objectKey)
        if (body.byteLength !== ref.ciphertextBytes || createHash('sha256').update(body).digest('hex') !== ref.ciphertextSha256) {
          this.json(response, 400, { error: 'object_integrity_failed' })
          return
        }
        this.objects.set(objectKey, { body, ref, entityId, tombstoned: false })
        response.writeHead(201, this.manifestHeaders(ref))
        response.end()
        return
      }
      if (method === 'GET') {
        const object = this.objects.get(objectKey)
        if (!object) {
          this.json(response, 404, { error: 'object_not_found' })
          return
        }
        if (object.tombstoned) {
          this.json(response, 410, { error: 'object_tombstoned' })
          return
        }
        response.writeHead(200, { ...this.manifestHeaders(object.ref), 'Content-Type': 'application/octet-stream' })
        response.end(object.body)
        return
      }
    }

    if (url.pathname === '/sync/v2/exchange' && method === 'POST') {
      const raw = (await this.body(request)).toString('utf8')
      this.requests.push({ method, path: url.pathname, body: raw })
      if (this.failNextExchange) {
        this.failNextExchange = false
        this.json(response, 503, { error: 'offline_fixture' })
        return
      }
      const envelope = JSON.parse(raw) as {
        protocolVersion: number
        envelopeVersion: number
        product: string
        deviceId: string
        cursor: string | null
        mutations: EncryptedMutation[]
      }
      if (
        envelope.protocolVersion !== 2 ||
        envelope.envelopeVersion !== 1 ||
        envelope.product !== 'journal' ||
        !this.authenticated(request, envelope.deviceId)
      ) {
        this.json(response, 401, { error: 'invalid_v2_envelope' })
        return
      }
      const acknowledged: Record<string, unknown>[] = []
      const conflicts: Record<string, unknown>[] = []
      for (const mutation of envelope.mutations) {
        if (mutation.operation === 'upsert') {
          const ciphertext = Buffer.from(mutation.ciphertext ?? '', 'base64url')
          const objectsValid = mutation.objects.every((ref) => {
            const stored = this.objects.get(ref.objectKey)
            return stored && JSON.stringify(stored.ref) === JSON.stringify(ref)
          })
          if (
            !mutation.ciphertext ||
            !mutation.ciphertextSha256 ||
            !mutation.nonce ||
            createHash('sha256').update(ciphertext).digest('hex') !== mutation.ciphertextSha256 ||
            !objectsValid
          ) {
            this.json(response, 400, { error: 'invalid_encrypted_mutation' })
            return
          }
        } else if (
          mutation.ciphertext !== null ||
          mutation.ciphertextSha256 !== null ||
          mutation.nonce !== null ||
          mutation.objects.length !== 0
        ) {
          this.json(response, 400, { error: 'invalid_encrypted_tombstone' })
          return
        }
        const requestHash = JSON.stringify(mutation)
        const replay = this.operations.get(mutation.opId)
        if (replay) {
          if (replay.request !== requestHash) {
            conflicts.push({
              outcome: 'conflict',
              opId: mutation.opId,
              entityType: mutation.entityType,
              entityId: mutation.entityId,
              operation: mutation.operation,
              error: 'OP_ID_REUSED',
              current: null,
              candidate: mutation,
            })
          } else {
            acknowledged.push({ ...replay.acknowledgement, replayed: true })
          }
          continue
        }
        const current = this.entities.get(mutation.entityId)
        const currentRevision = current?.revision ?? 0
        if (mutation.baseRevision !== currentRevision) {
          conflicts.push({
            outcome: 'conflict',
            opId: mutation.opId,
            entityType: mutation.entityType,
            entityId: mutation.entityId,
            operation: mutation.operation,
            error: 'REVISION_CONFLICT',
            current: this.currentState(mutation.entityId),
            candidate: mutation,
          })
          continue
        }
        const revision = currentRevision + 1
        const changedAt = new Date().toISOString()
        const change: SequencedChange = {
          entityType: 'journal_entry',
          entityId: mutation.entityId,
          revision,
          operation: mutation.operation,
          keyVersion: mutation.keyVersion,
          ciphertext: mutation.ciphertext,
          ciphertextSha256: mutation.ciphertextSha256,
          nonce: mutation.nonce,
          aadHash: mutation.aadHash,
          objects: mutation.objects,
          changedAt,
          originDeviceId: envelope.deviceId,
          operationId: mutation.opId,
          sequence: this.changes.length + 1,
        }
        this.entities.set(mutation.entityId, change)
        this.changes.push(change)
        if (mutation.operation === 'delete') {
          for (const object of this.objects.values()) {
            if (object.entityId === mutation.entityId) object.tombstoned = true
          }
        }
        const acknowledgement = {
          outcome: 'acknowledged',
          opId: mutation.opId,
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          operation: mutation.operation,
          revision,
        }
        this.operations.set(mutation.opId, { request: requestHash, acknowledgement })
        acknowledged.push(acknowledgement)
      }
      const cursor = envelope.cursor === null ? 0 : Number.parseInt(envelope.cursor.slice(1), 36)
      const changes = this.changes.filter((change) => change.sequence > cursor)
      const nextSequence = changes.at(-1)?.sequence ?? cursor
      this.json(response, 200, {
        protocolVersion: 2,
        envelopeVersion: 1,
        product: 'journal',
        acknowledged,
        conflicts,
        changes: changes.map(({ sequence: _sequence, ...change }) => change),
        nextCursor: `c${nextSequence.toString(36)}`,
        hasMore: false,
        serverTime: new Date().toISOString(),
      })
      return
    }

    this.json(response, 404, { error: 'not_found' })
  }
}

function journalEntry(
  date: string,
  marker: string,
  updatedAt: string,
  coverImage?: string,
): JournalEntry {
  return {
    schemaVersion: 2,
    date,
    title: marker,
    content: marker,
    blocks: [{
      id: `block-${date}`,
      content: marker,
      writeTimes: [updatedAt],
      writeStops: [{ sessionIndex: 0, offset: marker.length, at: updatedAt }],
      createdAt: updatedAt,
      updatedAt,
    }],
    mood: 4,
    tags: [`tag-${marker}`],
    ...(coverImage ? { coverImage } : {}),
    createdAt: updatedAt,
    updatedAt,
  }
}

test('App production entry is V2-only', async () => {
  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const androidManifest = await readFile(
    new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url),
    'utf8',
  )
  assert.match(appSource, /JournalV2SyncClient/)
  assert.match(appSource, /queueDelete/)
  assert.match(appSource, /syncMutationInFlight/)
  assert.match(appSource, /JOURNAL_ROOT_KEY_STORAGE_KEY/)
  for (const forbidden of ['/journal/all', '/journal/sync', '/sync/v1/', '/sync/push']) {
    assert.equal(appSource.includes(forbidden), false, forbidden)
  }
  assert.equal(appSource.includes("'http://127.0.0.1:8780'"), false)
  assert.match(androidManifest, /android:allowBackup="false"/)
  assert.match(androidManifest, /android:fullBackupContent="false"/)
  assert.equal(deviceIdFromToken(`dj1.approved-device.${'a'.repeat(43)}`), 'approved-device')
  assert.equal(deviceIdFromToken('unapproved-token'), null)
})

test('approved-device snapshots are isolated and corruption fails closed', async () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  const approved = new BrowserSyncStore(storage, 'https://journal-a.example', 'approved-device')
  const otherAuthority = new BrowserSyncStore(storage, 'https://journal-b.example', 'approved-device')
  const snapshot = emptySyncSnapshot()
  snapshot.cursor = 'c1'
  await approved.write(snapshot)
  assert.equal((await approved.read()).cursor, 'c1')
  assert.equal((await otherAuthority.read()).cursor, null)
  const storedKey = [...values.keys()][0]
  values.set(storedKey, '{corrupt')
  await assert.rejects(() => approved.read(), /SyntaxError|invalid_sync_snapshot/)
})

test('a newer remote text revision keeps the cover that exists only on this device', async () => {
  const authority = new V2Authority()
  const baseUrl = await authority.start()
  const rootKey = await initializeRootKey()
  const clientA = new JournalV2SyncClient({
    baseUrl,
    deviceToken: authority.approve('journal-cover-a', 'f'),
    rootKey,
    store: new MemoryStore(),
  })
  const clientB = new JournalV2SyncClient({
    baseUrl,
    deviceToken: authority.approve('journal-cover-b', 'g'),
    rootKey,
    store: new MemoryStore(),
  })
  const date = '2026-07-27'
  const coverImage = `data:image/png;base64,${Buffer.from('local-cover-only').toString('base64')}`
  const localEntries = {
    [date]: journalEntry(date, 'LOCAL_TEXT_V1', '2026-07-27T01:00:00.000Z', coverImage),
  }
  try {
    await clientA.synchronize(localEntries)
    await clientB.synchronize({})
    await clientB.synchronize({
      [date]: journalEntry(date, 'REMOTE_TEXT_V2', '2026-07-27T02:00:00.000Z'),
    })

    const merged = await clientA.synchronize(localEntries)

    assert.equal(merged.entries[date].content, 'REMOTE_TEXT_V2')
    assert.equal(merged.entries[date].coverImage, coverImage)
    assert.equal(authority.entities.get(date)?.revision, 2)
    assert.equal(authority.objectRouteCalls, 0)
    assert.ok(authority.requests.every((request) => {
      const envelope = JSON.parse(request.body) as { mutations: EncryptedMutation[] }
      return envelope.mutations.every((mutation) => mutation.objects.length === 0)
    }))
  } finally {
    await authority.stop()
  }
})

test('V2 client covers create, update, first pull, conflict, delete and restore without fallback', async () => {
  const authority = new V2Authority()
  const baseUrl = await authority.start()
  const rootKey = await initializeRootKey()
  const tokenA = authority.approve('journal-client-a', 'a')
  const tokenB = authority.approve('journal-client-b', 'b')
  const tokenC = authority.approve('journal-client-c', 'c')
  const tokenD = authority.approve('journal-client-d', 'd')
  const tokenE = authority.approve('journal-client-e', 'e')
  const storeA = new MemoryStore()
  const storeB = new MemoryStore()
  const storeC = new MemoryStore()
  const storeD = new MemoryStore()
  const storeE = new MemoryStore()
  const clientA = new JournalV2SyncClient({ baseUrl, deviceToken: tokenA, rootKey, store: storeA })
  const clientB = new JournalV2SyncClient({ baseUrl, deviceToken: tokenB, rootKey, store: storeB })
  const clientC = new JournalV2SyncClient({ baseUrl, deviceToken: tokenC, rootKey, store: storeC })
  const clientD = new JournalV2SyncClient({ baseUrl, deviceToken: tokenD, rootKey, store: storeD })
  const clientE = new JournalV2SyncClient({ baseUrl, deviceToken: tokenE, rootKey, store: storeE })
  const date = '2026-07-28'
  const coverBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const coverImage = `data:image/png;base64,${coverBytes.toString('base64')}`
  const plaintextMarkers: string[] = []
  try {
    const createdMarker = 'APP_V2_CREATE_PRIVATE_8f31'
    plaintextMarkers.push(createdMarker)
    const createdEntries: JournalEntries = {
      [date]: journalEntry(date, createdMarker, '2026-07-28T01:00:00.000Z', coverImage),
    }
    const created = await clientA.synchronize(createdEntries)
    assert.equal(created.entries[date].content, createdMarker)
    assert.equal(created.entries[date].coverImage, coverImage)
    assert.equal(authority.entities.get(date)?.revision, 1)
    assert.equal(authority.objects.size, 0)

    const firstPull = await clientB.synchronize({})
    assert.equal(firstPull.entries[date].content, createdMarker)
    assert.equal(firstPull.entries[date].coverImage, undefined)
    assert.equal((await clientE.synchronize({})).entries[date].content, createdMarker)

    const updatedMarker = 'APP_V2_UPDATE_PRIVATE_5d42'
    plaintextMarkers.push(updatedMarker)
    const updatedEntries: JournalEntries = {
      [date]: journalEntry(date, updatedMarker, '2026-07-28T02:00:00.000Z', coverImage),
    }
    const updated = await clientA.synchronize(updatedEntries)
    assert.equal(updated.entries[date].content, updatedMarker)
    assert.equal(updated.entries[date].coverImage, coverImage)
    assert.equal(authority.entities.get(date)?.revision, 2)

    const initialC = await clientC.synchronize({})
    assert.equal(initialC.entries[date].content, updatedMarker)
    const conflictMarker = 'APP_V2_CONFLICT_CANDIDATE_752a'
    plaintextMarkers.push(conflictMarker)
    const conflictEntries: JournalEntries = {
      [date]: journalEntry(date, conflictMarker, '2026-07-28T04:00:00.000Z', coverImage),
    }
    authority.failNextExchange = true
    await assert.rejects(() => clientC.synchronize(conflictEntries), /v2_exchange_failed:503/)
    assert.equal(storeC.value.outbox.length, 1, 'offline mutation must remain durable')
    assert.deepEqual(storeC.value.outbox[0].objects, [])
    const pendingPayload = await decryptMutation(rootKey, storeC.value.outbox[0])
    assert.equal(JSON.stringify(pendingPayload).includes('coverImage'), false)
    assert.equal(JSON.stringify(pendingPayload).includes('data:image'), false)
    const stableOperationId = storeC.value.outbox[0].opId

    const competingMarker = 'APP_V2_REMOTE_WINNER_02c4'
    plaintextMarkers.push(competingMarker)
    await clientA.synchronize({
      [date]: journalEntry(date, competingMarker, '2026-07-28T03:00:00.000Z', coverImage),
    })
    assert.equal(authority.entities.get(date)?.revision, 3)

    const resolved = await clientC.synchronize(conflictEntries)
    assert.equal(resolved.entries[date].content, conflictMarker)
    assert.equal(resolved.entries[date].coverImage, coverImage)
    assert.equal(authority.entities.get(date)?.revision, 4)
    assert.equal(storeC.value.records[date].conflicts.length, 1)
    assert.equal(storeC.value.records[date].conflicts[0].candidate?.opId, stableOperationId)

    await clientC.queueDelete(date)
    const deleted = await clientC.synchronize({})
    assert.equal(deleted.entries[date], undefined)
    assert.equal(authority.entities.get(date)?.operation, 'delete')
    assert.equal(authority.entities.get(date)?.revision, 5)

    const restoreMarker = 'APP_V2_RESTORED_PRIVATE_e803'
    plaintextMarkers.push(restoreMarker)
    const restoredAt = new Date(Date.now() + 60_000).toISOString()
    const restored = await clientC.synchronize({
      [date]: journalEntry(date, restoreMarker, restoredAt),
    })
    assert.equal(restored.entries[date].content, restoreMarker)
    assert.equal(authority.entities.get(date)?.operation, 'upsert')
    assert.equal(authority.entities.get(date)?.revision, 6)

    await clientD.queueDelete(date)
    const deletedBeforeFirstPull = await clientD.synchronize({})
    assert.equal(deletedBeforeFirstPull.entries[date], undefined)
    assert.equal(authority.entities.get(date)?.operation, 'delete')
    assert.equal(authority.entities.get(date)?.revision, 7)
    assert.equal(storeD.value.pendingDeletes.length, 0)
    assert.equal(storeD.value.records[date].conflicts[0].candidate?.operation, 'delete')

    assert.equal(authority.fallbackCalls, 0)
    assert.equal(authority.objectRouteCalls, 0)
    assert.ok(authority.requests.every((request) => request.path === '/sync/v2/exchange'))
    for (const request of authority.requests) {
      const envelope = JSON.parse(request.body) as { mutations: EncryptedMutation[] }
      for (const mutation of envelope.mutations) {
        assert.deepEqual(mutation.objects, [])
        if (mutation.operation === 'delete') continue
        const payload = await decryptMutation(rootKey, mutation)
        const keys: string[] = []
        JSON.stringify(payload, (key, value: unknown) => {
          if (key) keys.push(key)
          return value
        })
        assert.equal(keys.some((key) => /cover|base64|path|url/i.test(key)), false)
      }
    }
    for (const marker of plaintextMarkers) {
      assert.ok(authority.requests.every((request) => !request.body.includes(marker)), marker)
    }
    assert.ok(authority.requests.every((request) => !request.body.includes(rootKey.rawKey)))
  } finally {
    await authority.stop()
  }
})
