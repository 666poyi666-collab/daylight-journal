import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createJournalApp } from '../../server.mjs'

async function rpc(baseUrl, id, method, params = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  const payload = text.startsWith('event:')
    ? text.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
    : text
  assert(payload)
  return JSON.parse(payload)
}

test('Journal MCP exposes namespaced tools, Resources, writes, and content-safe audit logs', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-mcp-'))
  const auditFile = path.join(dataDir, 'logs', 'journal-audit.jsonl')
  const runtime = await createJournalApp({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    auditFile,
    version: 'test',
  })
  const listener = await new Promise((resolve) => {
    const value = runtime.app.listen(0, '127.0.0.1', () => resolve(value))
  })
  const address = listener.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  const marker = 'mcp-body-must-never-enter-audit'
  try {
    const tools = await rpc(baseUrl, 1, 'tools/list')
    assert.deepEqual(
      tools.result.tools.map((tool) => tool.name).sort(),
      [
        'journal_append_entry',
        'journal_create_entry',
        'journal_get_entry',
        'journal_get_status',
        'journal_list_recent',
        'journal_search',
        'journal_update_entry',
      ],
    )
    const templates = await rpc(baseUrl, 2, 'resources/templates/list')
    assert.equal(templates.result.resourceTemplates[0].uriTemplate, 'journal://entries/{date}')

    const write = await rpc(baseUrl, 3, 'tools/call', {
      name: 'journal_create_entry',
      arguments: {
        requestId: '66666666-6666-4666-8666-666666666666',
        expectedRevision: 0,
        date: '2026-07-26',
        title: 'MCP contract',
        content: marker,
      },
    })
    assert.equal(write.result.structuredContent.data.revision, 1)
    assert.doesNotMatch(JSON.stringify(write), new RegExp(marker))
    const replay = await rpc(baseUrl, 4, 'tools/call', {
      name: 'journal_create_entry',
      arguments: {
        requestId: '66666666-6666-4666-8666-666666666666',
        expectedRevision: 0,
        date: '2026-07-26',
        title: 'MCP contract',
        content: marker,
      },
    })
    assert.equal(replay.result.structuredContent.data.replayed, true)
    assert.doesNotMatch(JSON.stringify(replay), new RegExp(marker))

    const attachmentMarker = 'data:image/png;base64,MCP_ATTACHMENT_MUST_NOT_LEAK'
    const current = await runtime.store.getEntry('2026-07-26')
    await runtime.store.mergeIncoming([{
      ...current.entry,
      coverImage: attachmentMarker,
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    }])

    const metadata = await rpc(baseUrl, 5, 'tools/call', {
      name: 'journal_get_entry', arguments: { date: '2026-07-26' },
    })
    assert.equal(metadata.result.structuredContent.data.entry.resourceUri, 'journal://entries/2026-07-26')
    assert.equal(metadata.result.structuredContent.data.resourceIncluded, true)
    assert.equal(metadata.result.structuredContent.data.contentLength, marker.length)
    assert.deepEqual(metadata.result.content[1], {
      type: 'resource',
      resource: {
        uri: 'journal://entries/2026-07-26',
        mimeType: 'application/json',
        text: metadata.result.content[1].resource.text,
      },
    })
    assert.doesNotMatch(metadata.result.content[0].text, new RegExp(marker))
    assert.doesNotMatch(JSON.stringify(metadata.result.structuredContent), new RegExp(marker))
    assert.match(metadata.result.content[1].resource.text, new RegExp(marker))
    assert.doesNotMatch(metadata.result.content[1].resource.text, /MCP_ATTACHMENT_MUST_NOT_LEAK/)
    assert.equal(metadata.result.structuredContent.data.entry.hasImage, undefined)

    const resource = await rpc(baseUrl, 6, 'resources/read', { uri: 'journal://entries/2026-07-26' })
    assert.match(resource.result.contents[0].text, new RegExp(marker))
    assert.doesNotMatch(resource.result.contents[0].text, /MCP_ATTACHMENT_MUST_NOT_LEAK/)
    const audit = await fs.readFile(auditFile, 'utf8')
    assert.doesNotMatch(audit, new RegExp(marker))
    assert.doesNotMatch(audit, /MCP contract/)
    assert.doesNotMatch(audit, new RegExp(runtime.apiToken))
  } finally {
    await new Promise((resolve) => listener.close(resolve))
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
