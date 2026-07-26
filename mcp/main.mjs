import { startJournalServer, stopJournalServer } from './server.mjs'

const runtime = await startJournalServer()

async function shutdown() {
  runtime.health.ready = false
  await runtime.audit.record({ event: 'service_stopped', outcome: 'success' })
  await stopJournalServer(runtime)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
