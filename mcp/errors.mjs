import { JournalStoreError } from '../journal-store.mjs'

export function safeError(error) {
  if (error instanceof JournalStoreError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    }
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'Journal MCP could not complete the request',
    retryable: false,
    details: { type: error?.constructor?.name || 'Error' },
  }
}

export function mcpErrorResult(error, requestId) {
  const safe = safeError(error)
  const payload = { ok: false, requestId, error: safe }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}
