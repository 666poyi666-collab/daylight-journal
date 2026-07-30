import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const installerPath = path.resolve('desktop/install-pwa.ps1')

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

test('desktop installer creates a persistent standalone Edge app shortcut', async () => {
  const installer = await fs.readFile(installerPath, 'utf8')
  assert.match(installer, /GetFolderPath\('Programs'\)/)
  assert.match(installer, /'拾光\.lnk'/)
  assert.match(installer, /--app=/)
  assert.match(installer, /--user-data-dir=/)
  assert.match(installer, /GetFolderPath\('Startup'\)/)
})

test('brand icons keep PWA sizes and the ChatGPT upload budget', async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.resolve('public/manifest.webmanifest'), 'utf8'),
  )
  assert.deepEqual(
    manifest.icons.map(({ src, sizes, purpose }) => ({ src, sizes, purpose })),
    [
      {
        src: '/icon-journal-sunrise-192.png',
        sizes: '192x192',
        purpose: 'any',
      },
      {
        src: '/icon-journal-sunrise-512.png',
        sizes: '512x512',
        purpose: 'any',
      },
      {
        src: '/icon-journal-sunrise-maskable-512.png',
        sizes: '512x512',
        purpose: 'maskable',
      },
    ],
  )

  for (const [file, size] of [
    ['public/icon-journal-sunrise-192.png', 192],
    ['public/icon-journal-sunrise-512.png', 512],
    ['public/icon-journal-sunrise-maskable-512.png', 512],
  ]) {
    const image = await fs.readFile(path.resolve(file))
    assert.deepEqual(pngDimensions(image), { width: size, height: size })
  }

  const connectorIcon = await fs.readFile(
    path.resolve('resources/chatgpt-plugin-icon.png'),
  )
  assert.deepEqual(pngDimensions(connectorIcon), { width: 256, height: 256 })
  assert.ok(connectorIcon.byteLength <= 10 * 1024)

  const favicon = await fs.readFile(path.resolve('public/favicon.svg'), 'utf8')
  assert.match(favicon, /#6b3f24/)
  assert.match(favicon, /#a85f27/)
  assert.doesNotMatch(favicon, /#863bff/)

  const serviceWorker = await fs.readFile(path.resolve('public/sw.js'), 'utf8')
  assert.match(serviceWorker, /daylight-journal-v5/)
})

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

test('desktop PWA host serves only static loopback assets with safe caching', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-pwa-'))
  const webDir = path.join(sandbox, 'dist')
  await fs.mkdir(path.join(webDir, 'assets'), { recursive: true })
  await fs.writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>Journal PWA test</title>')
  await fs.writeFile(path.join(webDir, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  await fs.writeFile(path.join(webDir, 'assets', 'app.js'), 'export {}')
  const port = await freePort()
  const child = spawn(process.execPath, ['desktop/pwa-server.mjs'], {
    cwd: path.resolve('.'),
    env: { ...process.env, JOURNAL_PWA_DIR: webDir, JOURNAL_PWA_PORT: String(port) },
    stdio: 'ignore',
    windowsHide: true,
  })
  try {
    const baseUrl = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 10_000
    let root
    while (Date.now() < deadline) {
      try {
        root = await fetch(`${baseUrl}/`)
        if (root.ok) break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    assert.equal(root?.status, 200)
    assert.match(await root.text(), /Journal PWA test/)
    assert.equal((await fetch(`${baseUrl}/sw.js`)).headers.get('cache-control'), 'no-cache')
    assert.match(
      (await fetch(`${baseUrl}/assets/app.js`)).headers.get('cache-control') || '',
      /immutable/,
    )
    assert.equal((await fetch(`${baseUrl}/missing`)).status, 404)
    assert.equal((await fetch(`${baseUrl}/`, { method: 'POST' })).status, 405)
  } finally {
    child.kill('SIGTERM')
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})
