import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForServer(url, server) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Vite exited before readiness (${server.exitCode})`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Vite did not become ready for frontend smoke tests')
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

const port = await availablePort()
const appUrl = `http://127.0.0.1:${port}`
let serverOutput = ''
const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
)
server.stdout.on('data', (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-20_000) })
server.stderr.on('data', (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-20_000) })

try {
  await waitForServer(appUrl, server)
  const smoke = spawn(process.execPath, ['tests/frontend-smoke.mjs'], {
    cwd: root,
    env: { ...process.env, APP_URL: appUrl },
    stdio: 'inherit',
    windowsHide: true,
  })
  const result = await waitForExit(smoke)
  if (result.code !== 0) throw new Error(`Frontend smoke tests failed (${result.code ?? result.signal})`)
} catch (error) {
  if (serverOutput.trim()) process.stderr.write(`\nVite output:\n${serverOutput}\n`)
  throw error
} finally {
  if (server.exitCode === null) server.kill()
}
