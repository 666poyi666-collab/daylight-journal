import crypto from 'node:crypto'
import { mcpErrorResult, safeError } from './errors.mjs'
import * as schema from './schemas.mjs'

function toolResult(data, requestId) {
  const payload = { ok: true, requestId, data }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

function metadataOnly(value) {
  const { entry, revision, replayed } = value
  return {
    entry: {
      date: entry.date,
      title: entry.title,
      mood: entry.mood,
      tags: entry.tags,
      hasImage: Boolean(entry.coverImage),
      updatedAt: entry.updatedAt,
      revision,
      resourceUri: `journal://entries/${entry.date}`,
    },
    revision,
    ...(typeof replayed === 'boolean' ? { replayed } : {}),
  }
}

export function registerJournalTools(server, store, audit, health) {
  function register(name, config, operation) {
    server.registerTool(name, config, async (args = {}) => {
      const started = Date.now()
      const requestId = typeof args.requestId === 'string'
        ? args.requestId
        : `read-${crypto.randomUUID()}`
      health.toolCalls += 1
      try {
        const data = await operation(args)
        await audit.record({
          event: 'tool_call',
          requestId,
          tool: name,
          durationMs: Date.now() - started,
          outcome: 'success',
        })
        return toolResult(data, requestId)
      } catch (error) {
        health.toolFailures += 1
        const safe = safeError(error)
        await audit.record({
          event: 'tool_call',
          requestId,
          tool: name,
          durationMs: Date.now() - started,
          outcome: 'error',
          errorCode: safe.code,
        })
        return mcpErrorResult(error, requestId)
      }
    })
  }

  const readOnly = { readOnlyHint: true, openWorldHint: false }
  const reversibleWrite = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }

  register('journal_get_status', {
    title: '读取拾光日记状态',
    description: '读取 Journal 服务状态和日记数量，不返回日记正文。',
    annotations: readOnly,
  }, async () => await store.status())

  register('journal_list_recent', {
    title: '列出最近日记',
    description: '分页列出最近日记的日期、标题、短摘要和 Resource URI。',
    inputSchema: { limit: schema.limit, cursor: schema.cursor },
    annotations: readOnly,
  }, async ({ limit = 20, cursor = '' }) => await store.listEntries({ limit, cursor }))

  register('journal_search', {
    title: '搜索日记',
    description: '按关键词和日期范围搜索日记摘要；完整正文需读取返回的 Resource URI。',
    inputSchema: {
      query: schema.text.min(1),
      from: schema.date.optional(),
      to: schema.date.optional(),
      limit: schema.limit,
      cursor: schema.cursor,
    },
    annotations: readOnly,
  }, async ({ query, from, to, limit = 20, cursor = '' }) => (
    await store.listEntries({ query, from, to, limit, cursor })
  ))

  register('journal_get_entry', {
    title: '读取日记元数据',
    description: '读取指定日期的元数据、revision 和 Resource URI，不在工具响应中返回正文。',
    inputSchema: { date: schema.date },
    annotations: readOnly,
  }, async ({ date }) => metadataOnly(await store.getEntry(date)))

  register('journal_create_entry', {
    title: '创建日记',
    description: '幂等创建指定日期的日记。新建必须使用 expectedRevision 0。',
    inputSchema: {
      requestId: schema.requestId,
      expectedRevision: schema.expectedRevision,
      date: schema.date,
      title: schema.text.optional(),
      content: schema.text.optional(),
      mood: schema.mood,
      tags: schema.tags,
    },
    annotations: reversibleWrite,
  }, async (args) => metadataOnly(await store.createEntry(args.date, args)))

  register('journal_append_entry', {
    title: '追加日记记录片',
    description: '按 revision 幂等追加一张文字记录片，不覆盖已有正文。',
    inputSchema: {
      requestId: schema.requestId,
      expectedRevision: schema.expectedRevision,
      date: schema.date,
      content: schema.text.min(1).max(100_000),
    },
    annotations: reversibleWrite,
  }, async (args) => metadataOnly(await store.appendEntry(args.date, args)))

  register('journal_update_entry', {
    title: '更新日记元数据',
    description: '按 revision 幂等更新标题、心情或标签，不替换正文。',
    inputSchema: {
      requestId: schema.requestId,
      expectedRevision: schema.expectedRevision,
      date: schema.date,
      title: schema.text.optional(),
      mood: schema.mood,
      tags: schema.tags,
    },
    annotations: reversibleWrite,
  }, async ({ requestId, expectedRevision, date, title, mood, tags }) => {
    const patch = Object.fromEntries(
      Object.entries({ title, mood, tags }).filter(([, value]) => value !== undefined),
    )
    return metadataOnly(await store.updateEntry(date, { requestId, expectedRevision, patch }))
  })
}
