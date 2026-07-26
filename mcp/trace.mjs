const enabled = process.env.JOURNAL_TRACE === '1'

/**
 * Startup-phase breadcrumbs for service diagnosis. Writes one line per phase
 * to stderr (captured by the WinSW err log) when JOURNAL_TRACE=1. Phase names
 * only — never request data, journal content, paths, or tokens.
 */
export function trace(step) {
  if (enabled) process.stderr.write(`journal-trace ${new Date().toISOString()} ${step}\n`)
}
