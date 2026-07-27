import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'

const PAIRING_FILE = 'journal-pairing.json'
const DEFAULT_TTL_MS = 5 * 60 * 1000
const DEFAULT_ATTEMPTS = 5

function pairingPath(dataDir) {
  return path.join(dataDir, PAIRING_FILE)
}

function pairingHash(salt, code) {
  return crypto.createHash('sha256').update(`${salt}:${code}`, 'utf8').digest('hex')
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, filePath)
}

/** 创建短时一次性配对码；只返回给发起配对的管理员进程。 */
export async function startPairing(
  dataDir,
  { now = Date.now(), ttlMs = DEFAULT_TTL_MS, randomInt = crypto.randomInt } = {},
) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const salt = crypto.randomBytes(16).toString('base64url')
  const expiresAt = now + ttlMs
  await writeJsonAtomic(pairingPath(dataDir), {
    version: 1,
    salt,
    codeHash: pairingHash(salt, code),
    expiresAt,
    attemptsRemaining: DEFAULT_ATTEMPTS,
  })
  return { code, expiresAt }
}

function pairingError(res, status, code, message) {
  res.setHeader('Cache-Control', 'no-store')
  return res.status(status).json({
    error: { code, message, retryable: status !== 429, details: {} },
  })
}

export function createPairingRouter(dataDir, apiToken, { now = Date.now } = {}) {
  const router = express.Router()
  let exchangeChain = Promise.resolve()

  router.post('/exchange', (req, res) => {
    const exchange = exchangeChain.then(async () => {
      const code = typeof req.body?.code === 'string' ? req.body.code : ''
      if (!/^\d{6}$/.test(code)) {
        return pairingError(res, 400, 'PAIRING_CODE_INVALID', 'Pairing code must contain 6 digits')
      }

      const filePath = pairingPath(dataDir)
      let state
      try {
        state = JSON.parse(await fs.readFile(filePath, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
          return pairingError(res, 410, 'PAIRING_NOT_ACTIVE', 'No active pairing session')
        }
        throw error
      }

      if (!Number.isFinite(state.expiresAt) || state.expiresAt <= now()) {
        await fs.rm(filePath, { force: true })
        return pairingError(res, 410, 'PAIRING_EXPIRED', 'Pairing code has expired')
      }
      if (!Number.isInteger(state.attemptsRemaining) || state.attemptsRemaining <= 0) {
        await fs.rm(filePath, { force: true })
        return pairingError(res, 429, 'PAIRING_LOCKED', 'Pairing attempts were exhausted')
      }

      const actual = pairingHash(state.salt, code)
      const expected = String(state.codeHash || '')
      const matches = actual.length === expected.length && crypto.timingSafeEqual(
        Buffer.from(actual),
        Buffer.from(expected),
      )
      if (!matches) {
        state.attemptsRemaining -= 1
        if (state.attemptsRemaining <= 0) await fs.rm(filePath, { force: true })
        else await writeJsonAtomic(filePath, state)
        return pairingError(
          res,
          state.attemptsRemaining <= 0 ? 429 : 401,
          state.attemptsRemaining <= 0 ? 'PAIRING_LOCKED' : 'PAIRING_CODE_REJECTED',
          state.attemptsRemaining <= 0 ? 'Pairing attempts were exhausted' : 'Pairing code was rejected',
        )
      }

      await fs.rm(filePath, { force: true })
      res.setHeader('Cache-Control', 'no-store')
      return res.json({ token: apiToken })
    })
    exchangeChain = exchange.catch(() => undefined)
    exchange.catch(() => pairingError(res, 500, 'PAIRING_INTERNAL', 'Pairing could not be completed'))
  })

  return router
}
