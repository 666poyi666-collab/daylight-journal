import crypto from 'node:crypto'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createBearerAuth } from './journal-api.mjs'
import {
  PeerAttachmentStore,
  PeerAttachmentStoreError,
} from './peer-attachment-store.mjs'

/** Load the peer-only capability without reusing the Journal API credential. */
export async function loadOrCreatePeerAttachmentToken(dataDir) {
  if (process.env.JOURNAL_PEER_ATTACHMENT_TOKEN) {
    const configured = process.env.JOURNAL_PEER_ATTACHMENT_TOKEN
    if (configured.length < 32 || !/^[A-Za-z0-9_-]+$/.test(configured)) {
      throw new Error('JOURNAL_PEER_ATTACHMENT_TOKEN must be a 32+ character base64url secret')
    }
    return configured
  }
  const tokenFile = process.env.JOURNAL_PEER_ATTACHMENT_TOKEN_FILE
    ? path.resolve(process.env.JOURNAL_PEER_ATTACHMENT_TOKEN_FILE)
    : path.join(dataDir, 'journal-peer-attachment-token')
  try {
    const token = (await fs.readFile(tokenFile, 'utf8')).trim()
    if (token.length >= 32 && /^[A-Za-z0-9_-]+$/.test(token)) return token
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const token = crypto.randomBytes(32).toString('base64url')
  await fs.mkdir(path.dirname(tokenFile), { recursive: true })
  await fs.writeFile(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  return token
}

function errorResponse(error) {
  if (error instanceof PeerAttachmentStoreError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.status >= 500,
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
        message: 'The peer attachment service could not complete the request',
        retryable: false,
        details: {},
      },
    },
  }
}

function handler(operation) {
  return async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json(await operation(req))
    } catch (error) {
      const mapped = errorResponse(error)
      res.status(mapped.status).json(mapped.body)
    }
  }
}

export function createPeerAttachmentRouter(dataDir, token) {
  const router = express.Router()
  const store = new PeerAttachmentStore(dataDir)
  router.use(createBearerAuth(token))
  router.get('/', handler(async () => ({
    schemaVersion: 1,
    attachments: await store.list(),
    serverTime: new Date().toISOString(),
  })))
  router.put('/:date', handler(async (req) => await store.put(req.params.date, req.body)))
  return router
}
