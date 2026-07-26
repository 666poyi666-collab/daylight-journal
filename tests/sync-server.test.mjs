import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('MCP test server did not start')
}

test('journal sync rejects an older revision without touching real data', async () => {
  const port = await availablePort()
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daylight-sync-'))
  const resolvedDataDir = path.resolve(dataDir)
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`
  assert(resolvedDataDir.startsWith(tempRoot))
  assert(path.basename(resolvedDataDir).startsWith('daylight-sync-'))
  const server = spawn(process.execPath, ['mcp-server.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      MCP_PORT: String(port),
      JOURNAL_DATA_DIR: dataDir,
      JOURNAL_API_TOKEN: 'test-only-journal-api-token-000000000000',
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const syncHeaders = {
    Authorization: 'Bearer test-only-journal-api-token-000000000000',
    'Content-Type': 'application/json',
  }
  const baseEntry = {
    schemaVersion: 2,
    date: '2026-07-22',
    title: 'newer',
    content: 'newer content',
    blocks: [{
      id: 'sync-block',
      content: 'newer content',
      writeTimes: ['2026-07-22T08:10:00.000Z'],
      createdAt: '2026-07-22T08:00:00.000Z',
      updatedAt: '2026-07-22T09:00:00.000Z',
    }],
    mood: null,
    tags: [],
    createdAt: '2026-07-22T08:00:00.000Z',
    updatedAt: '2026-07-22T09:00:00.000Z',
  }
  try {
    await waitForHealth(baseUrl)
    for (const entry of [
      baseEntry,
      {
        ...baseEntry,
        title: 'older',
        content: 'older content',
        updatedAt: '2026-07-22T08:30:00.000Z',
      },
    ]) {
      const response = await fetch(`${baseUrl}/journal/sync`, {
        method: 'POST',
        headers: syncHeaders,
        body: JSON.stringify([entry]),
      })
      assert.equal(response.status, 200)
    }
    assert.equal((await fetch(`${baseUrl}/journal/all`)).status, 401)
    const stored = await fetch(`${baseUrl}/journal/all`, { headers: syncHeaders })
      .then((response) => response.json())
    assert.equal(stored['2026-07-22'].title, 'newer')
    assert.equal(stored['2026-07-22'].content, 'newer content')
    assert.deepEqual(
      stored['2026-07-22'].blocks[0].writeTimes,
      ['2026-07-22T08:10:00.000Z'],
    )
    const mcpResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'journal_get_entry',
          arguments: { date: '2026-07-22' },
        },
      }),
    })
    assert.equal(mcpResponse.status, 200)
    const mcpBody = await mcpResponse.text()
    const mcpPayload = JSON.parse(mcpBody.match(/^data: (.+)$/m)[1])
    assert.equal(mcpPayload.result.content[1].type, 'resource_link')
    assert.equal(mcpPayload.result.content[1].uri, 'journal://entries/2026-07-22')
    assert.match(mcpPayload.result.content[0].text, /newer content/)
    assert.match(JSON.stringify(mcpPayload.result.structuredContent), /newer content/)
    assert.doesNotMatch(mcpBody, /base64/)
  } finally {
    if (server.exitCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve))
      server.kill()
      await exited
    }
    await fs.rm(resolvedDataDir, { recursive: true, force: true })
  }
})
