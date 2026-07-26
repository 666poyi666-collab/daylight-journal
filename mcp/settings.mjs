import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export function getSettings() {
  const dataDir = process.env.JOURNAL_DATA_DIR
    ? path.resolve(process.env.JOURNAL_DATA_DIR)
    : path.join(projectRoot, 'data')
  return {
    projectRoot,
    dataDir,
    host: process.env.JOURNAL_MCP_HOST || process.env.MCP_HOST || '127.0.0.1',
    port: Number(process.env.JOURNAL_MCP_PORT || process.env.MCP_PORT || 8780),
    syncHost: process.env.JOURNAL_SYNC_HOST || '',
    syncPort: Number(process.env.JOURNAL_SYNC_PORT || 8781),
    auditFile: process.env.JOURNAL_AUDIT_FILE
      ? path.resolve(process.env.JOURNAL_AUDIT_FILE)
      : path.join(dataDir, 'logs', 'journal-mcp-audit.jsonl'),
    version: '1.0.0',
  }
}
