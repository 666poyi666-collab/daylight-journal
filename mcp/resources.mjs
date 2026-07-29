import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { safeError } from './errors.mjs'

export function registerJournalResources(server, store, audit, health) {
  server.registerResource(
    'journal-entry',
    new ResourceTemplate('journal://entries/{date}', { list: undefined }),
    {
      title: '拾光日记完整内容',
      description: '读取指定日期的完整日记；仅在明确需要长正文时使用。',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const started = Date.now()
      health.resourceReads += 1
      try {
        const value = await store.getEntry(String(variables.date))
        await audit.record({
          event: 'resource_read',
          resource: 'journal-entry',
          durationMs: Date.now() - started,
          outcome: 'success',
        })
        const { coverImage: _localOnlyAttachment, ...entryWithoutAttachment } = value.entry
        const resourceValue = { ...value, entry: entryWithoutAttachment }
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(resourceValue),
          }],
        }
      } catch (error) {
        const safe = safeError(error)
        await audit.record({
          event: 'resource_read',
          resource: 'journal-entry',
          durationMs: Date.now() - started,
          outcome: 'error',
          errorCode: safe.code,
        })
        throw new Error(`${safe.code}: ${safe.message}`)
      }
    },
  )
}
