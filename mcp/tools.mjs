import crypto from 'node:crypto'
import { mcpErrorResult, safeError } from './errors.mjs'
import * as schema from './schemas.mjs'

function toolResult(data, requestId) {
  const payload = { ok: true, requestId, data }
  const resourceUri = data?.entry?.resourceUri
  const content = [{ type: 'text', text: JSON.stringify(payload) }]
  if (typeof resourceUri === 'string') {
    content.push({
      type: 'resource_link',
      uri: resourceUri,
      name: 'journal-entry',
      description: '完整日记正文，仅在明确需要时读取。',
      mimeType: 'application/json',
    })
  }
  return {
    content,
    structuredContent: payload,
  }
}

function withContentAccess(value) {
  return {
    ...value,
    contentAccess: {
      tool: 'journal_get_entry',
      instruction: '对每篇结果调用 journal_get_entry；不要把列表摘要当作完整正文。',
    },
  }
}

function entryResourceResult(result, requestId) {
  const { value, offset, maxChars } = result
  const body = typeof value.entry.content === 'string'
    ? value.entry.content
    : value.entry.blocks?.map((block) => block.content ?? '').join('\n\n---\n\n') ?? ''
  const contentOffset = Math.min(offset, body.length)
  const contentChunk = body.slice(contentOffset, contentOffset + maxChars)
  const consumed = contentOffset + contentChunk.length
  const nextOffset = consumed < body.length ? consumed : null
  const data = {
    ...metadataOnly(value),
    resourceIncluded: true,
    contentLength: body.length,
    contentOffset,
    contentChunk,
    contentComplete: nextOffset === null,
    nextOffset,
  }
  const payload = { ok: true, requestId, data }
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload) },
      {
        type: 'resource_link',
        uri: data.entry.resourceUri,
        name: 'journal-entry',
        description: '权威完整日记 Resource；ChatGPT 正文读取使用当前工具的分页字段。',
        mimeType: 'application/json',
      },
    ],
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
  function register(name, config, operation, formatResult = toolResult, resourceName = '') {
    server.registerTool(name, config, async (args = {}) => {
      const started = Date.now()
      const requestId = typeof args.requestId === 'string'
        ? args.requestId
        : `read-${crypto.randomUUID()}`
      health.toolCalls += 1
      try {
        const data = await operation(args)
        if (resourceName) {
          health.resourceReads += 1
          await audit.record({
            event: 'resource_read',
            resource: resourceName,
            durationMs: Date.now() - started,
            outcome: 'success',
          })
        }
        await audit.record({
          event: 'tool_call',
          requestId,
          tool: name,
          durationMs: Date.now() - started,
          outcome: 'success',
        })
        return formatResult(data, requestId)
      } catch (error) {
        health.toolFailures += 1
        const safe = safeError(error)
        if (resourceName) {
          await audit.record({
            event: 'resource_read',
            resource: resourceName,
            durationMs: Date.now() - started,
            outcome: 'error',
            errorCode: safe.code,
          })
        }
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
    description: '分页列出最近日记摘要。用户要查看或复盘时，必须继续对每篇调用 journal_get_entry 读取正文。',
    inputSchema: { limit: schema.limit, cursor: schema.cursor },
    annotations: readOnly,
  }, async ({ limit = 20, cursor = '' }) => withContentAccess(await store.listEntries({ limit, cursor })))

  register('journal_search', {
    title: '搜索日记',
    description: '按关键词和日期范围搜索摘要。命中后必须调用 journal_get_entry 分块读取正文，不能只依据摘要回答。',
    inputSchema: {
      query: schema.text.min(1),
      from: schema.date.optional(),
      to: schema.date.optional(),
      limit: schema.limit,
      cursor: schema.cursor,
    },
    annotations: readOnly,
  }, async ({ query, from, to, limit = 20, cursor = '' }) => withContentAccess(
    await store.listEntries({ query, from, to, limit, cursor }),
  ))

  register('journal_get_entry', {
    title: '读取日记正文',
    description: '读取指定日期的正文分块。默认返回最多 6000 字符；若 contentComplete 为 false，必须用 nextOffset 继续读取，直到完成。',
    inputSchema: {
      date: schema.date,
      offset: schema.contentOffset,
      maxChars: schema.contentLimit,
    },
    annotations: readOnly,
  }, async ({ date, offset = 0, maxChars = 6_000 }) => ({
    value: await store.getEntry(date),
    offset,
    maxChars,
  }), entryResourceResult, 'journal-entry')

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
