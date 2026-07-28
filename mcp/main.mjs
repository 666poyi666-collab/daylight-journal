import { trace } from './trace.mjs'

trace('imports-start')
const { startJournalServer, stopJournalServer } = await import('./server.mjs')
trace('imports-done')

const runtime = await startJournalServer()
trace('startup-complete')

async function shutdown() {
  runtime.health.ready = false
  await runtime.audit.record({ event: 'service_stopped', outcome: 'success' })
  await stopJournalServer(runtime)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
