import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createJournalApp, createJournalSyncApp } from '../../server.mjs'
import { startPairing } from '../../pairing.mjs'

test('Journal v1 API authenticates, reports capabilities, and maps conflicts', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-api-'))
  const runtime = await createJournalApp({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    auditFile: path.join(dataDir, 'audit.jsonl'),
    version: 'test',
  })
  const listener = await new Promise((resolve) => {
    const value = runtime.app.listen(0, '127.0.0.1', () => resolve(value))
  })
  const address = listener.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  const syncApp = createJournalSyncApp(runtime.store, runtime.apiToken, dataDir)
  const syncListener = await new Promise((resolve) => {
    const value = syncApp.listen(0, '127.0.0.1', () => resolve(value))
  })
  const syncAddress = syncListener.address()
  const syncBaseUrl = `http://127.0.0.1:${syncAddress.port}`
  const headers = {
    Authorization: `Bearer ${runtime.apiToken}`,
    'Content-Type': 'application/json',
  }
  try {
    assert.equal((await fetch(`${baseUrl}/v1/status`)).status, 401)
    assert.equal((await fetch(`${baseUrl}/journal/all`)).status, 401)
    assert.equal((await fetch(`${baseUrl}/journal/all`, { headers })).status, 200)
    assert.equal((await fetch(`${syncBaseUrl}/healthz`)).status, 200)
    const privateNetworkPreflight = await fetch(`${syncBaseUrl}/pairing/exchange`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://localhost',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
        'Access-Control-Request-Private-Network': 'true',
      },
    })
    assert.equal(privateNetworkPreflight.status, 204)
    assert.equal(
      privateNetworkPreflight.headers.get('access-control-allow-private-network'),
      'true',
    )
    const untrustedPreflight = await fetch(`${syncBaseUrl}/pairing/exchange`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://untrusted.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true',
      },
    })
    assert.equal(untrustedPreflight.headers.has('access-control-allow-private-network'), false)
    assert.equal((await fetch(`${baseUrl}/pairing/exchange`, { method: 'POST' })).status, 404)

    await startPairing(dataDir, { randomInt: () => 123456 })
    const wrongPairing = await fetch(`${syncBaseUrl}/pairing/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '654321' }),
    })
    assert.equal(wrongPairing.status, 401)
    assert.equal((await wrongPairing.json()).error.code, 'PAIRING_CODE_REJECTED')
    const paired = await fetch(`${syncBaseUrl}/pairing/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    })
    assert.equal(paired.status, 200)
    assert.equal((await paired.json()).token, runtime.apiToken)
    const replay = await fetch(`${syncBaseUrl}/pairing/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    })
    assert.equal(replay.status, 410)
    assert.equal((await replay.json()).error.code, 'PAIRING_NOT_ACTIVE')

    await startPairing(dataDir, { randomInt: () => 111111 })
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const rejected = await fetch(`${syncBaseUrl}/pairing/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '222222' }),
      })
      assert.equal(rejected.status, attempt === 5 ? 429 : 401)
    }

    await startPairing(dataDir, { now: 1, ttlMs: 1, randomInt: () => 333333 })
    const expired = await fetch(`${syncBaseUrl}/pairing/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '333333' }),
    })
    assert.equal(expired.status, 410)
    assert.equal((await expired.json()).error.code, 'PAIRING_EXPIRED')

    const protectedResource = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)
      .then((response) => response.json())
    assert.equal(protectedResource.resource, `${baseUrl}/mcp`)
    assert.deepEqual(protectedResource.authorization_servers, [baseUrl])

    const authorizationServer = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)
      .then((response) => response.json())
    assert.equal(authorizationServer.issuer, baseUrl)
    assert.equal(authorizationServer.token_endpoint, `${baseUrl}/oauth/token`)
    assert.deepEqual(authorizationServer.code_challenge_methods_supported, ['S256'])
    assert.equal((await fetch(`${syncBaseUrl}/journal/all`)).status, 401)
    assert.equal((await fetch(`${syncBaseUrl}/journal/all`, { headers })).status, 200)
    assert.equal((await fetch(`${syncBaseUrl}/mcp`)).status, 404)
    const health = await fetch(`${baseUrl}/v1/health`, { headers }).then((response) => response.json())
    assert.equal(health.service, 'journal-api')
    const capabilities = await fetch(`${baseUrl}/v1/capabilities`, { headers }).then((response) => response.json())
    assert.equal(capabilities.revisionScheme, 'monotonic_integer')
    assert.deepEqual(capabilities.controlCommands, [])
    assert.equal(capabilities.lanSync.mdnsServiceType, '_poyi-journal._tcp.local')

    const body = {
      requestId: '44444444-4444-4444-8444-444444444444',
      expectedRevision: 0,
      date: '2026-07-26',
      title: 'API contract',
      content: 'api-private-marker',
    }
    const created = await fetch(`${baseUrl}/v1/entries`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }).then((response) => response.json())
    assert.equal(created.revision, 1)
    const replayed = await fetch(`${baseUrl}/v1/entries`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }).then((response) => response.json())
    assert.equal(replayed.replayed, true)

    const conflictResponse = await fetch(`${baseUrl}/v1/entries/2026-07-26/append`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: '55555555-5555-4555-8555-555555555555',
        expectedRevision: 0,
        content: 'must not be written',
      }),
    })
    assert.equal(conflictResponse.status, 409)
    assert.equal((await conflictResponse.json()).error.code, 'REVISION_CONFLICT')

    const list = await fetch(`${baseUrl}/v1/entries?query=contract`, { headers }).then((response) => response.json())
    assert.equal(list.total, 1)
    assert.equal(list.items[0].resourceUri, 'journal://entries/2026-07-26')
  } finally {
    await new Promise((resolve) => listener.close(resolve))
    await new Promise((resolve) => syncListener.close(resolve))
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
