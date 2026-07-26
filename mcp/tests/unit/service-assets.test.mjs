import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve('.')

test('Journal services, ports, and profile are isolated', async () => {
  const mcpXml = await fs.readFile(path.join(root, 'mcp/service/service.xml'), 'utf8')
  const tunnelXml = await fs.readFile(path.join(root, 'mcp/tunnel/service.xml'), 'utf8')
  const tunnelRun = await fs.readFile(path.join(root, 'mcp/tunnel/run-service.ps1'), 'utf8')
  const mcpInstall = await fs.readFile(path.join(root, 'mcp/service/install.ps1'), 'utf8')
  const tunnelInstall = await fs.readFile(path.join(root, 'mcp/tunnel/install.ps1'), 'utf8')
  const tunnelDoctor = await fs.readFile(path.join(root, 'mcp/tunnel/doctor.ps1'), 'utf8')
  assert.match(mcpXml, /<id>PoyiJournalMcp<\/id>/)
  assert.match(mcpXml, /JOURNAL_MCP_PORT[^\n]+8780/)
  assert.match(mcpXml, /%BASE%\\mcp\\main\.mjs/)
  assert.match(mcpXml, /JOURNAL_SYNC_HOST[^\n]+0\.0\.0\.0/)
  assert.match(mcpXml, /JOURNAL_SYNC_PORT[^\n]+8781/)
  assert.match(tunnelXml, /<id>PoyiJournalTunnel<\/id>/)
  assert.match(tunnelXml, /<depend>PoyiJournalMcp<\/depend>/)
  assert.match(tunnelRun, /--profile journal/)
  assert.match(tunnelRun, /127\.0\.0\.1:8780\/readyz/)
  assert.match(mcpInstall, /function Invoke-Icacls/)
  assert.match(mcpInstall, /serviceSid`:M/)
  assert.match(mcpInstall, /-ne 'service-logs'/)
  assert.match(mcpInstall, /-ne 'tunnel-runtime-key\.dpapi'/)
  assert.match(mcpInstall, /PoyiJournalSyncApi/)
  assert.match(mcpInstall, /RemoteAddress LocalSubnet/)
  assert.match(mcpInstall, /tunnelWasRunning/)
  assert.match(mcpInstall, /Start-Service -Name 'PoyiJournalTunnel'/)
  assert.match(mcpInstall, /Wait-TunnelReady/)
  assert.match(tunnelInstall, /tunnel-runtime-key\.dpapi[^\n]+\/inheritance:r/)
  assert.match(tunnelInstall, /127\.0\.0\.1:8887/)
  assert.doesNotMatch(tunnelInstall, /127\.0\.0\.1:8987/)
  assert.match(tunnelDoctor, /--health\.listen-addr '127\.0\.0\.1:0'/)
  assert.doesNotMatch(tunnelInstall, /resolvedData \/grant:r[^\n]+\(OI\)\(CI\)RX[^\n]+\/T/)
  assert.doesNotMatch(`${mcpXml}\n${tunnelXml}\n${tunnelRun}`, /PersonalMcpGateway|8760\/mcp|8877/)
})

test('Journal MCP runtime has no raw console logging or sensitive audit fields', async () => {
  const runtimeFiles = await Promise.all(
    ['audit.mjs', 'errors.mjs', 'health.mjs', 'main.mjs', 'resources.mjs', 'server.mjs', 'settings.mjs', 'tools.mjs']
      .map((name) => fs.readFile(path.join(root, 'mcp', name), 'utf8')),
  )
  const runtime = runtimeFiles.join('\n')
  assert.doesNotMatch(runtime, /console\.(log|error|warn)/)
  const audit = await fs.readFile(path.join(root, 'mcp/audit.mjs'), 'utf8')
  assert.doesNotMatch(audit, /['"](?:content|title|tags|coverImage|token)['"]/)
})

test('deployed verification reports only safe aggregate fields', async () => {
  const verify = await fs.readFile(path.join(root, 'mcp/service/verify.ps1'), 'utf8')
  assert.match(verify, /SensitiveValueFound/)
  assert.match(verify, /AnonymousStatus/)
  assert.match(verify, /Journal service verification failed/)
  assert.doesNotMatch(verify, /Write-(?:Host|Output)[^\n]*(?:token|content|title|tags)/i)
})
