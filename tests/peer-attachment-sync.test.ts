import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createJournalApp, createJournalSyncApp } from '../mcp/server.mjs'
import { initializeRootKey } from '../src/journal/encrypted-sync.ts'
import {
  BrowserPeerAttachmentStore,
  JournalPeerAttachmentClient,
  normalizePeerAttachmentUrl,
} from '../src/journal/peer-attachment-sync.ts'
import type { JournalEntries, JournalEntry } from '../src/journal/model.ts'

function entry(
  date: string,
  updatedAt: string,
  coverImage?: string,
): JournalEntry {
  return {
    schemaVersion: 2,
    date,
    title: 'peer attachment test',
    content: 'text continues to use encrypted cloud V2',
    blocks: [],
    mood: null,
    tags: [],
    ...(coverImage ? { coverImage } : {}),
    createdAt: updatedAt,
    updatedAt,
  }
}

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    },
  }
}

async function listen(app: ReturnType<typeof createJournalSyncApp>): Promise<{
  baseUrl: string
  close: () => Promise<void>
}> {
  const server = await new Promise<import('node:http').Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
    listener.once('error', reject)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeIdleConnections()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

test('peer URL policy accepts direct networks and rejects public or tunneled hosts', () => {
  assert.equal(normalizePeerAttachmentUrl('http://127.0.0.1:8781'), 'http://127.0.0.1:8781')
  assert.equal(normalizePeerAttachmentUrl('http://192.168.8.2:8781/'), 'http://192.168.8.2:8781')
  assert.equal(normalizePeerAttachmentUrl('https://journal-pc.local:8781'), 'https://journal-pc.local:8781')
  assert.equal(normalizePeerAttachmentUrl('https://journal.example.com'), null)
  assert.equal(normalizePeerAttachmentUrl('https://journal-pc.local.evil.test'), null)
  assert.equal(normalizePeerAttachmentUrl('https://user:secret@192.168.1.2:8781'), null)
  assert.equal(normalizePeerAttachmentUrl('https://192.168.1.2:8781/tunnel'), null)
})

test('attachments synchronize encrypted only over the LAN-only peer service', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-peer-'))
  const runtime = await createJournalApp({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    auditFile: path.join(dataDir, 'audit.jsonl'),
    version: 'test',
  })
  const peerServer = await listen(createJournalSyncApp(
    runtime.store,
    runtime.peerAttachmentToken,
  ))
  const mainServer = await listen(runtime.app)
  const rootKey = await initializeRootKey()
  const pcStorage = memoryStorage()
  const phoneStorage = memoryStorage()
  const pcClient = new JournalPeerAttachmentClient(
    peerServer.baseUrl,
    runtime.peerAttachmentToken,
    rootKey,
    new BrowserPeerAttachmentStore(pcStorage.storage, peerServer.baseUrl),
  )
  const phoneClient = new JournalPeerAttachmentClient(
    peerServer.baseUrl,
    runtime.peerAttachmentToken,
    rootKey,
    new BrowserPeerAttachmentStore(phoneStorage.storage, peerServer.baseUrl),
  )
  const date = '2026-07-29'
  const firstAt = '2026-07-29T01:00:00.000Z'
  const secondAt = '2026-07-29T02:00:00.000Z'
  const deletedAt = '2026-07-29T03:00:00.000Z'
  const firstCover = `data:image/png;base64,${Buffer.from('PEER_ONLY_IMAGE_A').toString('base64')}`
  const secondCover = `data:image/jpeg;base64,${Buffer.from('PEER_ONLY_IMAGE_B').toString('base64')}`

  try {
    assert.equal((await fetch(`${peerServer.baseUrl}/v1/peer-attachments`)).status, 401)
    assert.equal((await fetch(`${peerServer.baseUrl}/v1/peer-attachments`, {
      headers: { Authorization: `Bearer ${runtime.apiToken}` },
    })).status, 401, 'the main Journal API token must not authorize peer attachments')
    assert.equal((await fetch(`${mainServer.baseUrl}/v1/peer-attachments`, {
      headers: { Authorization: `Bearer ${runtime.apiToken}` },
    })).status, 404)
    assert.equal((await fetch(`${peerServer.baseUrl}/journal/all`, {
      headers: { Authorization: `Bearer ${runtime.apiToken}` },
    })).status, 404)
    assert.equal((await fetch(`${peerServer.baseUrl}/mcp`)).status, 404)

    const pcEntries: JournalEntries = {
      [date]: entry(date, firstAt, firstCover),
    }
    const firstUpload = await pcClient.synchronize(pcEntries)
    assert.equal(firstUpload.pendingCount, 0)
    assert.equal(
      Object.keys(await new BrowserPeerAttachmentStore(
        pcStorage.storage,
        peerServer.baseUrl,
      ).read().then((snapshot) => snapshot.pending)).length,
      1,
      'a crash before ACK commit must retain the exact encrypted pending envelope',
    )
    const restartedPc = new JournalPeerAttachmentClient(
      peerServer.baseUrl,
      runtime.peerAttachmentToken,
      rootKey,
      new BrowserPeerAttachmentStore(pcStorage.storage, peerServer.baseUrl),
    )
    const replayedAfterCrash = await restartedPc.synchronize(pcEntries)
    await replayedAfterCrash.commit()
    assert.equal((await new BrowserPeerAttachmentStore(
      pcStorage.storage,
      peerServer.baseUrl,
    ).read()).pending[date], undefined)

    const stored = await fs.readFile(
      path.join(dataDir, 'journal-peer-attachments.json'),
      'utf8',
    )
    assert.doesNotMatch(stored, /PEER_ONLY_IMAGE_A/)
    assert.doesNotMatch(stored, /data:image/)
    assert.match(stored, /"ciphertext":/)
    const storedState = JSON.parse(stored) as {
      records: Record<string, Record<string, unknown>>
    }
    const duplicateResponse = await fetch(
      `${peerServer.baseUrl}/v1/peer-attachments/${date}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${runtime.peerAttachmentToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(storedState.records[date]),
      },
    )
    assert.equal(duplicateResponse.status, 200)
    assert.equal((await duplicateResponse.json()).replayed, true)
    const corrupted = {
      ...storedState.records[date],
      updatedAt: '2026-07-29T01:30:00.000Z',
      ciphertextSha256: '0'.repeat(64),
    }
    const corruptedResponse = await fetch(
      `${peerServer.baseUrl}/v1/peer-attachments/${date}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${runtime.peerAttachmentToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(corrupted),
      },
    )
    assert.equal(corruptedResponse.status, 400)
    assert.equal((await corruptedResponse.json()).error.code, 'INVALID_ENVELOPE')

    const firstPull = await phoneClient.synchronize({
      [date]: entry(date, '2026-07-29T00:30:00.000Z'),
    })
    assert.equal(firstPull.entries[date].coverImage, firstCover)
    await firstPull.commit()

    const wrongKeyClient = new JournalPeerAttachmentClient(
      peerServer.baseUrl,
      runtime.peerAttachmentToken,
      await initializeRootKey(),
      new BrowserPeerAttachmentStore(memoryStorage().storage, peerServer.baseUrl),
    )
    await assert.rejects(
      () => wrongKeyClient.synchronize({
        [date]: entry(date, '2026-07-29T00:30:00.000Z'),
      }),
      /undecryptable_peer_attachment/,
    )

    await pcClient.queue(date, secondCover, secondAt)
    const secondUpload = await pcClient.synchronize({
      [date]: entry(date, secondAt, secondCover),
    })
    await secondUpload.commit()
    const secondPull = await phoneClient.synchronize(firstPull.entries)
    assert.equal(secondPull.entries[date].coverImage, secondCover)
    await secondPull.commit()

    await pcClient.queue(date, null, deletedAt)
    const deleteUpload = await pcClient.synchronize({
      [date]: entry(date, deletedAt),
    })
    await deleteUpload.commit()
    const deletePull = await phoneClient.synchronize(secondPull.entries)
    assert.equal(deletePull.entries[date].coverImage, undefined)
    await deletePull.commit()

    const restartedPhone = new JournalPeerAttachmentClient(
      peerServer.baseUrl,
      runtime.peerAttachmentToken,
      rootKey,
      new BrowserPeerAttachmentStore(phoneStorage.storage, peerServer.baseUrl),
    )
    const afterRestart = await restartedPhone.synchronize(deletePull.entries)
    assert.equal(afterRestart.entries[date].coverImage, undefined)
    await afterRestart.commit()

    const divergentStorage = memoryStorage()
    const divergentClient = new JournalPeerAttachmentClient(
      peerServer.baseUrl,
      runtime.peerAttachmentToken,
      rootKey,
      new BrowserPeerAttachmentStore(divergentStorage.storage, peerServer.baseUrl),
    )
    const divergentCover = `data:image/png;base64,${Buffer.from('DIVERGENT').toString('base64')}`
    await assert.rejects(
      () => divergentClient.synchronize({
        [date]: entry(date, deletedAt, divergentCover),
      }),
      /peer_attachment_equal_timestamp_divergence/,
    )
  } finally {
    await mainServer.close()
    await peerServer.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('offline peer transfer keeps its encrypted pending envelope for retry', async () => {
  const rootKey = await initializeRootKey()
  const local = memoryStorage()
  const peerUrl = 'http://192.168.88.10:8781'
  const store = new BrowserPeerAttachmentStore(local.storage, peerUrl)
  let online = false
  const remote = new Map<string, unknown>()
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!online) throw new Error('network_offline')
    assert.ok(String(input).startsWith(peerUrl))
    if (init?.method === 'PUT') {
      const envelope = JSON.parse(String(init.body)) as { date: string }
      const replayed = remote.has(envelope.date) &&
        JSON.stringify(remote.get(envelope.date)) === JSON.stringify(envelope)
      remote.set(envelope.date, envelope)
      return Response.json({ envelope, replayed })
    }
    return Response.json({
      schemaVersion: 1,
      attachments: [...remote.values()],
      serverTime: new Date().toISOString(),
    })
  }
  const client = new JournalPeerAttachmentClient(
    peerUrl,
    'local-pairing-token-00000000000000000000',
    rootKey,
    store,
    fetcher,
  )
  const date = '2026-07-30'
  const cover = `data:image/webp;base64,${Buffer.from('OFFLINE_PEER_IMAGE').toString('base64')}`
  await client.queue(date, cover, '2026-07-30T01:00:00.000Z')
  await assert.rejects(
    () => client.synchronize({ [date]: entry(date, '2026-07-30T01:00:00.000Z', cover) }),
    /network_offline/,
  )
  const snapshot = await store.read()
  assert.equal(Object.keys(snapshot.pending).length, 1)
  assert.equal(snapshot.pending[date].operation, 'upsert')
  assert.equal(JSON.stringify(snapshot).includes('OFFLINE_PEER_IMAGE'), false)
  assert.equal(JSON.stringify(snapshot).includes('data:image'), false)
  online = true
  const reconnected = await client.synchronize({
    [date]: entry(date, '2026-07-30T01:00:00.000Z', cover),
  })
  await reconnected.commit()
  assert.equal(Object.keys((await store.read()).pending).length, 0)
  assert.equal(remote.size, 1)

  const secondDevice = new JournalPeerAttachmentClient(
    peerUrl,
    'local-pairing-token-00000000000000000000',
    rootKey,
    new BrowserPeerAttachmentStore(memoryStorage().storage, peerUrl),
    fetcher,
  )
  const pulled = await secondDevice.synchronize({
    [date]: entry(date, '2026-07-30T00:30:00.000Z'),
  })
  assert.equal(pulled.entries[date].coverImage, cover)
})
