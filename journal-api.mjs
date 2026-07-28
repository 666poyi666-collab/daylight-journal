import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { JournalStoreError } from './journal-store.mjs'

export async function loadOrCreateApiToken(dataDir) {
  if (process.env.JOURNAL_API_TOKEN) return process.env.JOURNAL_API_TOKEN
  const tokenFile = process.env.JOURNAL_API_TOKEN_FILE
    ? path.resolve(process.env.JOURNAL_API_TOKEN_FILE)
    : path.join(dataDir, 'journal-api-token')
  try {
    const token = (await fs.readFile(tokenFile, 'utf8')).trim()
    if (token.length >= 32) return token
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const token = crypto.randomBytes(32).toString('base64url')
  await fs.mkdir(path.dirname(tokenFile), { recursive: true })
  await fs.writeFile(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  return token
}

function errorResponse(error) {
  if (error instanceof JournalStoreError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          details: error.details,
        },
      },
    }
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The journal API could not complete the request',
        retryable: false,
        details: { type: error?.constructor?.name || 'Error' },
      },
    },
  }
}

function handler(operation) {
  return async (req, res) => {
    try {
      res.json(await operation(req))
    } catch (error) {
      const mapped = errorResponse(error)
      res.status(mapped.status).json(mapped.body)
    }
  }
}

export function createBearerAuth(token) {
  if (typeof token !== 'string' || token.length < 32) {
    throw new Error('JOURNAL_API_TOKEN must contain at least 32 characters')
  }
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    const supplied = req.headers.authorization
    const expected = `Bearer ${token}`
    if (
      typeof supplied !== 'string' ||
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      return res.status(401).json({
        error: { code: 'AUTH_FAILED', message: 'Bearer token was rejected', retryable: false, details: {} },
      })
    }
    next()
  }
}

export function createJournalApiRouter(store, token) {
  const router = express.Router()
  router.use(createBearerAuth(token))
  router.get('/health', handler(async () => ({ ok: true, ...(await store.status()) })))
  router.get('/status', handler(async () => await store.status()))
  router.get('/capabilities', handler(async () => ({
    apiVersion: 1,
    authentication: 'bearer_token',
    revisionScheme: 'monotonic_integer',
    idempotency: { requestId: true, persistentReplay: true, ttlDays: 30 },
    reads: ['status', 'capabilities', 'list_entries', 'get_entry'],
    writes: ['create_entry', 'append_entry', 'update_entry_metadata'],
    controlCommands: [],
    resources: ['journal://entries/{date}'],
    lanSync: {
      mdnsServiceType: '_poyi-journal._tcp.local',
      stableDeviceId: true,
      pairingToken: true,
      oneTimePairingCode: { digits: 6, ttlSeconds: 300, maxAttempts: 5 },
    },
    limits: { listEntries: 100, appendCharacters: 100000 },
  })))
  router.get('/entries', handler(async (req) => await store.listEntries({
    from: req.query.from,
    to: req.query.to,
    query: req.query.query,
    limit: req.query.limit,
    cursor: req.query.cursor,
  })))
  router.get('/entries/:date', handler(async (req) => await store.getEntry(req.params.date)))
  router.post('/entries', handler(async (req) => await store.createEntry(req.body.date, req.body)))
  router.post('/entries/:date/append', handler(async (req) => await store.appendEntry(req.params.date, req.body)))
  router.patch('/entries/:date', handler(async (req) => await store.updateEntry(req.params.date, req.body)))
  return router
}
