import express from 'express'
import cors from 'cors'
import { Bonjour } from 'bonjour-service'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  createBearerAuth,
  createJournalApiRouter,
  loadOrCreateApiToken,
} from '../journal-api.mjs'
import { JournalStore } from '../journal-store.mjs'
import { AuditLogger } from './audit.mjs'
import { JournalHealth } from './health.mjs'
import { registerJournalResources } from './resources.mjs'
import { getSettings } from './settings.mjs'
import { registerJournalTools } from './tools.mjs'

export function createMcpServer(store, audit, health, version) {
  const server = new McpServer(
    { name: 'Journal MCP', version },
    {
      instructions: '查看或复盘日记时，先用 journal_list_recent 或 journal_search 定位记录，再对每篇调用 journal_get_entry 读取正文。若 contentComplete 为 false，必须用 nextOffset 继续调用，直到正文读取完成；不要只依据列表摘要分析。',
    },
  )
  registerJournalTools(server, store, audit, health)
  registerJournalResources(server, store, audit, health)
  return server
}

function configureHttpApp(app) {
  app.disable('x-powered-by')
  app.use(express.json({ limit: '4mb' }))
  app.use(cors({ origin: true, exposedHeaders: ['Mcp-Session-Id'] }))
}

function registerOAuthDiscoveryRoutes(app) {
  app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`
    res.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    })
  })
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
    })
  })
}

function registerBusinessRoutes(app, store, apiToken) {
  app.use('/v1', createJournalApiRouter(store, apiToken))
  app.use('/journal', createBearerAuth(apiToken))
  app.get('/journal/all', async (_req, res) => res.json(await store.readEntries()))
  app.post('/journal/sync', async (req, res) => {
    const incoming = Array.isArray(req.body) ? req.body : Object.values(req.body || {})
    res.json({ ok: true, count: await store.mergeIncoming(incoming) })
  })
}

export function createJournalSyncApp(store, apiToken) {
  const app = express()
  configureHttpApp(app)
  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'Journal Sync API' }))
  registerBusinessRoutes(app, store, apiToken)
  return app
}

export async function createJournalApp(settings = getSettings()) {
  const store = new JournalStore(settings.dataDir)
  await store.initialize()
  const apiToken = await loadOrCreateApiToken(settings.dataDir)
  const audit = new AuditLogger(settings.auditFile)
  const health = new JournalHealth(settings.version)
  const app = express()
  configureHttpApp(app)
  app.get('/healthz', (_req, res) => res.json({ ok: true, ...health.snapshot() }))
  app.get('/readyz', async (_req, res) => {
    try {
      await store.status()
      health.ready = true
      res.json({ ok: true, ...health.snapshot() })
    } catch {
      health.ready = false
      res.status(503).json({ ok: false, ...health.snapshot('unavailable') })
    }
  })
  app.get('/metrics', (_req, res) => {
    res.type('text/plain; version=0.0.4').send(health.metrics())
  })
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'Journal MCP' }))
  registerOAuthDiscoveryRoutes(app)
  registerBusinessRoutes(app, store, apiToken)

  app.post('/mcp', async (req, res) => {
    health.mcpRequests += 1
    const server = createMcpServer(store, audit, health, settings.version)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch {
      await audit.record({ event: 'mcp_request', outcome: 'error', errorCode: 'PROTOCOL_ERROR' })
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Journal MCP protocol error' },
          id: null,
        })
      }
    } finally {
      await transport.close().catch(() => undefined)
      await server.close().catch(() => undefined)
    }
  })
  app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Use POST for MCP requests' }))
  app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'Stateless MCP sessions cannot be deleted' }))

  return { app, store, audit, health, apiToken, settings }
}

export async function startJournalServer(settings = getSettings()) {
  const runtime = await createJournalApp(settings)
  const server = await new Promise((resolve, reject) => {
    const listener = runtime.app.listen(settings.port, settings.host, () => resolve(listener))
    listener.once('error', reject)
  })
  let syncServer = null
  let bonjour = null
  let advertisement = null
  if (settings.syncHost) {
    const syncApp = createJournalSyncApp(runtime.store, runtime.apiToken)
    syncServer = await new Promise((resolve, reject) => {
      const listener = syncApp.listen(settings.syncPort, settings.syncHost, () => resolve(listener))
      listener.once('error', reject)
    })
    const syncAddress = syncServer.address()
    const syncPort = typeof syncAddress === 'object' && syncAddress ? syncAddress.port : settings.syncPort
    const service = await runtime.store.initialize()
    bonjour = new Bonjour()
    advertisement = bonjour.publish({
      name: `Journal-${service.serviceId.slice(-8)}`,
      type: 'poyi-journal',
      protocol: 'tcp',
      port: syncPort,
      txt: { serviceId: service.serviceId, apiVersion: '1' },
    })
  }
  runtime.health.ready = true
  await runtime.audit.record({ event: 'service_started', outcome: 'success' })
  return { ...runtime, server, syncServer, bonjour, advertisement }
}

export async function stopJournalServer(runtime) {
  runtime.health.ready = false
  if (runtime.advertisement) {
    await new Promise((resolve) => runtime.advertisement.stop(resolve))
  }
  runtime.bonjour?.destroy()
  const servers = [runtime.syncServer, runtime.server].filter(Boolean)
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
}
