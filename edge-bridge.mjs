import http from 'node:http'
import { chromium } from 'playwright-core'

const port = Number(process.env.EDGE_BRIDGE_PORT || 3002)
const cdp = process.env.EDGE_CDP_URL || 'http://127.0.0.1:9222'
let busy = false

async function review(prompt) {
  if (busy) throw new Error('Edge 正在处理上一条复盘请求')
  busy = true
  let browser
  try {
    browser = await chromium.connectOverCDP(cdp)
    const pages = browser.contexts().flatMap((context) => context.pages())
    const page = pages.find((candidate) => /chatgpt\.com/i.test(candidate.url())) || pages[0]
    if (!page) throw new Error('没有找到 Edge 页面')
    await page.bringToFront()
    const editor = page.locator('textarea').first()
    await editor.waitFor({ state: 'visible', timeout: 8000 })
    await editor.fill(prompt)
    await editor.press('Enter')
    const messages = page.locator('[data-message-author-role="assistant"]')
    const before = await messages.count()
    await page.waitForFunction((count) => document.querySelectorAll('[data-message-author-role="assistant"]').length > count, before, { timeout: 120000 })
    const last = messages.last()
    await last.waitFor({ state: 'visible', timeout: 30000 })
    await page.waitForTimeout(1200)
    return (await last.innerText()).trim()
  } finally {
    await browser?.close()
    busy = false
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  if (req.method === 'OPTIONS') return res.end()
  if (req.method !== 'POST' || req.url !== '/chatgpt/review') { res.writeHead(404); return res.end() }
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', async () => {
    try {
      const { prompt } = JSON.parse(body)
      if (!prompt) throw new Error('缺少 prompt')
      const answer = await review(prompt)
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ answer }))
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
})
server.listen(port, '0.0.0.0', () => console.log(`Edge bridge listening on http://0.0.0.0:${port}`))
