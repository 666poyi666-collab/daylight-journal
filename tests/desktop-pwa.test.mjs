import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const installerPath = path.resolve('desktop/install-pwa.ps1')

test('desktop installer creates a persistent standalone Edge app shortcut', async () => {
  const installer = await fs.readFile(installerPath, 'utf8')
  assert.match(installer, /GetFolderPath\('Programs'\)/)
  assert.match(installer, /'拾光\.lnk'/)
  assert.match(installer, /--app=/)
  assert.match(installer, /--user-data-dir=/)
  assert.match(installer, /GetFolderPath\('Startup'\)/)
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
