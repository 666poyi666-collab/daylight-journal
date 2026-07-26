import assert from 'node:assert/strict'
import { Bonjour } from 'bonjour-service'

async function rpc(id, method, params = {}) {
  const response = await fetch('http://127.0.0.1:8780/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  assert.equal(response.status, 200)
  const body = await response.text()
  const data = body.startsWith('event:')
    ? body.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
    : body
  assert(data)
  return JSON.parse(data)
}

async function discoverJournal() {
  const bonjour = new Bonjour()
  let browser
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8_000)
      browser = bonjour.find({ type: 'poyi-journal', protocol: 'tcp' }, (service) => {
        clearTimeout(timer)
        resolve(service)
      })
    })
  } finally {
    browser?.stop()
    bonjour.destroy()
  }
}

assert.equal((await fetch('http://127.0.0.1:8780/healthz')).status, 200)
assert.equal((await fetch('http://127.0.0.1:8780/readyz')).status, 200)
assert.equal((await fetch('http://127.0.0.1:8780/metrics')).status, 200)
assert.equal((await fetch('http://127.0.0.1:8781/healthz')).status, 200)
assert.equal((await fetch('http://127.0.0.1:8781/v1/status')).status, 401)
assert.equal((await fetch('http://127.0.0.1:8781/mcp')).status, 404)

const tools = await rpc(1, 'tools/list')
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
const resources = await rpc(2, 'resources/templates/list')
assert.equal(resources.result.resourceTemplates[0].uriTemplate, 'journal://entries/{date}')

const discovered = await discoverJournal()
assert(discovered)
assert.equal(discovered.port, 8781)
assert.match(discovered.txt?.serviceId || '', /^journal-/)
assert.equal(discovered.txt?.apiVersion, '1')

console.log(JSON.stringify({
  ok: true,
  toolCount: tools.result.tools.length,
  resourceTemplateCount: resources.result.resourceTemplates.length,
  lanPort: discovered.port,
  stableDeviceId: true,
}))
