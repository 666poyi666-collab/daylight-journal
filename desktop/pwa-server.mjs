import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const installRoot = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(process.env.JOURNAL_PWA_DIR || path.join(installRoot, 'dist'))
const port = Number(process.env.JOURNAL_PWA_PORT || 8782)
const host = '127.0.0.1'

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

function safeFilePath(requestUrl) {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(requestUrl, `http://${host}:${port}`).pathname)
  } catch {
    return null
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const candidate = path.resolve(webRoot, relative)
  return candidate === webRoot || candidate.startsWith(`${webRoot}${path.sep}`)
    ? candidate
    : null
}

const server = http.createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return
  }
  const filePath = safeFilePath(request.url || '/')
  if (!filePath) {
    response.writeHead(400).end()
    return
  }
  try {
    const value = await fs.readFile(filePath)
    const fileName = path.basename(filePath)
    const immutable = filePath.includes(`${path.sep}assets${path.sep}`)
    response.writeHead(200, {
      'Cache-Control': fileName === 'index.html' || fileName === 'sw.js'
        ? 'no-cache'
        : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'Content-Type': contentTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(request.method === 'HEAD' ? undefined : value)
  } catch (error) {
    response.writeHead(error?.code === 'ENOENT' ? 404 : 500).end()
  }
})

server.listen(port, host)

async function shutdown() {
  await new Promise((resolve) => server.close(resolve))
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
