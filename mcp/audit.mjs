import fs from 'node:fs/promises'
import path from 'node:path'

const ALLOWED_FIELDS = new Set([
  'timestamp',
  'event',
  'requestId',
  'tool',
  'resource',
  'durationMs',
  'outcome',
  'errorCode',
])

export class AuditLogger {
  constructor(file) {
    this.file = file
    this.queue = Promise.resolve()
  }

  async record(value) {
    const event = { timestamp: new Date().toISOString() }
    for (const [key, item] of Object.entries(value)) {
      if (ALLOWED_FIELDS.has(key) && ['string', 'number', 'boolean'].includes(typeof item)) {
        event[key] = item
      }
    }
    const run = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.appendFile(this.file, `${JSON.stringify(event)}\n`, 'utf8')
    })
    this.queue = run.then(() => undefined, () => undefined)
    await run
  }
}
