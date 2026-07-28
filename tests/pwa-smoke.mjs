import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const executablePath = [
  process.env.BROWSER_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((candidate) => candidate && fs.existsSync(candidate))
if (!executablePath) throw new Error('Chrome or Edge executable was not found')

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

async function waitForServer(url) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Vite preview did not start')
}

const port = await availablePort()
const appUrl = `http://127.0.0.1:${port}`
const preview = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port)],
  { cwd: path.resolve('.'), stdio: 'ignore', windowsHide: true },
)
await waitForServer(appUrl)

const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  serviceWorkers: 'allow',
})
const page = await context.newPage()
if (process.env.NO_SCREENSHOTS === '1') page.screenshot = async () => Buffer.alloc(0)
const browserErrors = []
page.on('pageerror', (error) => browserErrors.push(error.message))
page.on('requestfailed', (request) => {
  browserErrors.push(`${request.url()}: ${request.failure()?.errorText}`)
})
await page.route(/\/journal\/(all|sync)$/, async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: route.request().method() === 'GET' ? '{}' : '{"ok":true}',
  })
})
await page.addInitScript(() => sessionStorage.setItem('daylight-splash-seen', '1'))

try {
  await page.goto(appUrl, { waitUntil: 'networkidle' })
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  const cachedUrls = await page.evaluate(async () => {
    const keys = await caches.keys()
    return (await Promise.all(
      keys.map(async (key) => {
        const cache = await caches.open(key)
        return (await cache.keys()).map((request) => request.url)
      }),
    )).flat()
  })
  assert(cachedUrls.some((url) => url.includes('/assets/') && url.endsWith('.js')))
  assert(cachedUrls.some((url) => url.includes('/assets/') && url.endsWith('.css')))
  await page.getByLabel('日记正文').fill('离线刷新后仍然保留')
  await page.waitForTimeout(700)
  const previewExited = new Promise((resolve) => preview.once('exit', resolve))
  preview.kill()
  await previewExited
  await page.reload({ waitUntil: 'domcontentloaded' })
  try {
    await page.locator('.app-shell').waitFor()
  } catch (error) {
    console.error('PWA browser errors:', browserErrors)
    console.error('PWA cached URLs:', cachedUrls)
    console.error('PWA page:', (await page.content()).slice(0, 2_000))
    throw error
  }
  await page.getByRole('textbox', { name: '日记正文' }).click()
  assert.equal(await page.getByLabel('日记正文').inputValue(), '离线刷新后仍然保留')
  const artifactDir = path.join(os.tmpdir(), 'daylight-journal-e2e')
  fs.mkdirSync(artifactDir, { recursive: true })
  await page.screenshot({
    path: path.join(artifactDir, 'pwa-offline.png'),
    fullPage: true,
  })
  console.log(`PWA offline smoke test passed. Artifact: ${artifactDir}`)
} finally {
  if (preview.exitCode === null) preview.kill()
  await browser.close()
}
