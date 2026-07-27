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
  const pairDevice = await fs.readFile(path.join(root, 'mcp/service/pair-device.ps1'), 'utf8')
  const verifyPairing = await fs.readFile(path.join(root, 'mcp/service/verify-pairing.ps1'), 'utf8')
  assert.match(mcpXml, /<id>PoyiJournalMcp<\/id>/)
  assert.match(mcpXml, /JOURNAL_MCP_PORT[^\n]+8780/)
  assert.match(mcpXml, /%BASE%\\mcp\\main\.mjs/)
  assert.match(mcpXml, /JOURNAL_SYNC_HOST[^\n]+0\.0\.0\.0/)
  assert.match(mcpXml, /JOURNAL_SYNC_PORT[^\n]+8781/)
  assert.match(mcpXml, /JOURNAL_TRACE[^\n]+1/)
  assert.match(tunnelXml, /<id>PoyiJournalTunnel<\/id>/)
  assert.match(tunnelXml, /<depend>PoyiJournalMcp<\/depend>/)
  assert.match(tunnelRun, /--profile journal/)
  assert.match(tunnelRun, /127\.0\.0\.1:8780\/readyz/)
  assert.match(mcpInstall, /function Invoke-Icacls/)
  assert.match(mcpInstall, /serviceSid`:M/)
  assert.match(mcpInstall, /-ne 'service-logs'/)
  assert.match(mcpInstall, /-ne 'tunnel-runtime-key\.dpapi'/)
  assert.match(mcpInstall, /excludedportrange/)
  assert.match(mcpInstall, /Reserve-JournalPorts -StartPort 8780 -Count 2/)
  assert.match(tunnelInstall, /excludedportrange/)
  assert.match(tunnelInstall, /Reserve-JournalPorts -StartPort 8887 -Count 1/)
  assert.match(mcpInstall, /PoyiJournalSyncApi/)
  assert.match(mcpInstall, /拾光手机配对\.lnk/)
  assert.match(pairDevice, /-Verb RunAs/)
  assert.match(pairDevice, /pairing-cli\.mjs/)
  assert.match(verifyPairing, /ReplayStatus/)
  assert.doesNotMatch(verifyPairing, /Write-(?:Host|Output)[^\n]*(?:code|token)/i)
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
    ['audit.mjs', 'errors.mjs', 'health.mjs', 'main.mjs', 'resources.mjs', 'server.mjs', 'settings.mjs', 'tools.mjs', 'trace.mjs']
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
  assert.match(verify, /excludedportrange/)
  assert.doesNotMatch(verify, /Write-(?:Host|Output)[^\n]*(?:token|content|title|tags)/i)
})

test('Android discovers LAN sync without broadcasting credentials', async () => {
  const mainActivity = await fs.readFile(
    path.join(root, 'android/app/src/main/java/com/daylight/journal/MainActivity.java'),
    'utf8',
  )
  const discovery = await fs.readFile(
    path.join(root, 'android/app/src/main/java/com/daylight/journal/JournalDiscoveryPlugin.java'),
    'utf8',
  )
  const manifest = await fs.readFile(
    path.join(root, 'android/app/src/main/AndroidManifest.xml'),
    'utf8',
  )
  assert.match(mainActivity, /registerPlugin\(JournalDiscoveryPlugin\.class\)/)
  assert.match(discovery, /_poyi-journal\._tcp\./)
  assert.match(discovery, /8781\/healthz/)
  assert.match(discovery, /\\"service\\":\\"Journal Sync API\\"/)
  assert.doesNotMatch(discovery, /Authorization|Bearer|journal-api-token/)
  assert.match(manifest, /android\.permission\.ACCESS_WIFI_STATE/)
  assert.match(manifest, /android\.permission\.CHANGE_WIFI_MULTICAST_STATE/)
})
