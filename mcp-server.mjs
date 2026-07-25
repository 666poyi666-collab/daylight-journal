import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import cors from 'cors'
import express from 'express'
import { z } from 'zod'
import { mergeIncomingEntries } from './sync-merge.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.JOURNAL_DATA_DIR
  ? path.resolve(process.env.JOURNAL_DATA_DIR)
  : path.join(root, 'data')
const dataFile = path.join(dataDir, 'journals.json')
const port = Number(process.env.MCP_PORT || 3001)
const token = process.env.MCP_TOKEN || ''
const sseTransports = new Map()
let journalWriteQueue = Promise.resolve()

async function readEntries() {
  try { return JSON.parse(await fs.readFile(dataFile, 'utf8')) } catch { return {} }
}

async function writeEntries(entries) {
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(dataFile, JSON.stringify(entries, null, 2), 'utf8')
}

function journalForAi(entry) {
  if (!entry) return entry
  const { coverImage, content, blocks, ...metadata } = entry
  if (Array.isArray(blocks)) {
    return {
      ...metadata,
      blocks: blocks.map((block) => ({
        content: block.content,
        writeTimes: block.writeTimes,
      })),
      hasImage: Boolean(coverImage),
    }
  }
  return { ...metadata, content, hasImage: Boolean(coverImage) }
}

function authorised(req, res, next) {
  if (!token || req.headers.authorization === `Bearer ${token}` || req.headers['x-mcp-token'] === token) return next()
  return res.status(401).json({ error: 'Unauthorized' })
}

function makeServer() {
  const server = new McpServer({ name: 'daylight-journal', version: '0.1.0' })
  server.registerTool('get_today_journal', {
    title: '读取今天的日记',
    description: '读取今天的日记内容和元数据。只读，不会修改日记。',
    inputSchema: { date: z.string().optional().describe('日期，格式 YYYY-MM-DD；不传则使用今天') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ date }) => {
    const entries = await readEntries()
    const key = date || new Date().toISOString().slice(0, 10)
    const entry = entries[key]
    return { content: [{ type: 'text', text: entry ? JSON.stringify(journalForAi(entry), null, 2) : `日期 ${key} 没有日记记录。` }] }
  })
  server.registerTool('get_journal_by_date', {
    title: '读取指定日期日记',
    description: '读取指定日期的完整日记内容。只读。',
    inputSchema: { date: z.string().describe('日期，格式 YYYY-MM-DD') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ date }) => {
    const entry = (await readEntries())[date]
    return { content: [{ type: 'text', text: entry ? JSON.stringify(journalForAi(entry), null, 2) : `日期 ${date} 没有日记记录。` }] }
  })
  server.registerTool('list_recent_journals', {
    title: '列出最近日记',
    description: '列出最近的日记日期、标题和摘要。只读。',
    inputSchema: { limit: z.number().int().min(1).max(30).default(7).describe('最多返回多少篇') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ limit = 7 }) => {
    const entries = await readEntries()
    const result = Object.values(entries).filter((entry) => entry.content?.trim() || entry.title?.trim() || entry.coverImage).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit).map((entry) => ({ date: entry.date, title: entry.title, mood: entry.mood, hasImage: Boolean(entry.coverImage), summary: entry.content.slice(0, 220) }))
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  })
  return server
}

// 通过 Cloudflare Tunnel 暴露时 Host 会是公网域名，关闭仅针对 localhost 的 Host 校验。
const app = express()
app.use(express.json({ limit: '4mb' }))
app.use(cors({ origin: true, exposedHeaders: ['Mcp-Session-Id'] }))
app.use('/journal', authorised)
app.get('/health', (_req, res) => res.json({ ok: true, service: 'daylight-journal-mcp' }))
app.get('/journal/all', async (_req, res) => res.json(await readEntries()))
app.post('/journal/sync', async (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : Object.values(req.body || {})
  const run = journalWriteQueue.then(async () => {
    const existing = await readEntries()
    const merged = mergeIncomingEntries(existing, incoming)
    await writeEntries(merged)
    return Object.keys(merged).length
  })
  journalWriteQueue = run.then(
    () => undefined,
    () => undefined,
  )
  res.json({ ok: true, count: await run })
})

app.post('/mcp', async (req, res) => {
  const server = makeServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
    res.on('close', () => { transport.close(); server.close() })
  } catch (error) {
    console.error(error)
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
  }
})
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Use POST for MCP requests' }))
app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'Stateless MCP sessions cannot be deleted' }))

// 兼容 ChatGPT 自定义连接器仍在使用的 HTTP+SSE 传输。
app.get('/sse', async (_req, res) => {
  res.setHeader('X-Accel-Buffering', 'no')
  res.setHeader('Content-Encoding', 'none')
  const transport = new SSEServerTransport('/messages', res)
  sseTransports.set(transport.sessionId, transport)
  res.on('close', () => sseTransports.delete(transport.sessionId))
  const server = makeServer()
  await server.connect(transport)
  res.flushHeaders()
})
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId
  const transport = sseTransports.get(sessionId)
  if (!transport) return res.status(400).send('No transport found for sessionId')
  await transport.handlePostMessage(req, res, req.body)
})

app.listen(port, () => console.log(`拾光 MCP server listening on http://127.0.0.1:${port}`))
