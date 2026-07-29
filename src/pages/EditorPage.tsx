import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUpRight,
  Bold,
  Bot,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  GripVertical,
  ImagePlus,
  Italic,
  Maximize2,
  Minimize2,
  Palette,
  Plus,
  Sparkles,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import {
  createJournalBlock,
  hasEntryContent,
  hasReviewableText,
  journalBlocksToContent,
  journalPreviewText,
  type JournalBlock,
  type JournalEntry,
  type JournalTextColor,
  type JournalWriteStop,
} from '../journal/model.ts'
import { resizeJournalImage } from '../journal/image.ts'
import { journalMoods } from '../journal/moods.ts'
import type { SaveState, SyncState } from '../journal/status.ts'

/** 今天的时段词：让日期区带一点此刻的空气感。 */
function timePhase(): string {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 9) return '清晨'
  if (hour < 12) return '上午'
  if (hour < 17) return '午后'
  if (hour < 20) return '傍晚'
  if (hour < 23) return '夜里'
  return '深夜'
}

function growTextarea(element: HTMLTextAreaElement) {
  if (element.scrollHeight > element.clientHeight) {
    element.style.height = `${element.scrollHeight}px`
  }
}

function fitTextarea(element: HTMLTextAreaElement) {
  element.style.height = 'auto'
  element.style.height = `${element.scrollHeight}px`
}

function rebaseWriteStops(
  previousContent: string,
  nextContent: string,
  writeStops: JournalWriteStop[],
): JournalWriteStop[] {
  if (previousContent === nextContent) return writeStops
  let prefixLength = 0
  while (
    prefixLength < previousContent.length &&
    prefixLength < nextContent.length &&
    previousContent[prefixLength] === nextContent[prefixLength]
  ) {
    prefixLength += 1
  }
  let suffixLength = 0
  while (
    suffixLength < previousContent.length - prefixLength &&
    suffixLength < nextContent.length - prefixLength &&
    previousContent[previousContent.length - 1 - suffixLength] ===
      nextContent[nextContent.length - 1 - suffixLength]
  ) {
    suffixLength += 1
  }
  const previousSuffixStart = previousContent.length - suffixLength
  const delta = nextContent.length - previousContent.length
  return writeStops.flatMap((stop) => {
    if (stop.offset <= prefixLength) return [stop]
    if (stop.offset >= previousSuffixStart) {
      return [{ ...stop, offset: Math.max(0, stop.offset + delta) }]
    }
    return []
  })
}

function renderTimedBlockText(block: JournalBlock) {
  const stops = [...block.writeStops].sort(
    (left, right) => left.offset - right.offset || left.sessionIndex - right.sessionIndex,
  )
  let cursor = 0
  return (
    <>
      {stops.map((stop) => {
        const offset = Math.max(cursor, Math.min(stop.offset, block.content.length))
        const content = block.content.slice(cursor, offset)
        cursor = offset
        return (
          <span key={`${stop.sessionIndex}-${stop.offset}-${stop.at}`}>
            {content}
            <time className="inline-write-stop" dateTime={stop.at} title="停笔时间">
              {format(parseISO(stop.at), 'HH:mm:ss')}
            </time>
          </span>
        )
      })}
      {block.content.slice(cursor)}
    </>
  )
}

function readBlockPositions(): Map<string, DOMRect> {
  return new Map(
    Array.from(document.querySelectorAll<HTMLElement>('[data-block-id]')).map(
      (element) => [element.dataset.blockId || '', element.getBoundingClientRect()],
    ),
  )
}

function animateBlockReorder(previous: Map<string, DOMRect>) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  requestAnimationFrame(() => {
    for (const element of document.querySelectorAll<HTMLElement>('[data-block-id]')) {
      if (element.classList.contains('is-moving')) continue
      const before = previous.get(element.dataset.blockId || '')
      if (!before) continue
      const after = element.getBoundingClientRect()
      const deltaY = before.top - after.top
      if (Math.abs(deltaY) < 1) continue
      element.animate(
        [
          { transform: `translateY(${deltaY}px)` },
          { transform: 'translateY(0)' },
        ],
        { duration: 220, easing: 'cubic-bezier(0.22, 0.8, 0.24, 1)' },
      )
    }
  })
}

export function EditorPage({
  entry,
  memoryEntries,
  selectedDate,
  todayKey,
  wordCount,
  saveState,
  syncState,
  reviewLaunched,
  reviewError,
  onToday,
  onOpenDate,
  onChangeDate,
  onUpdate,
  onDelete,
  onOpenChatGpt,
}: {
  entry: JournalEntry;
  memoryEntries: JournalEntry[];
  selectedDate: string;
  todayKey: string;
  wordCount: number;
  saveState: SaveState;
  syncState: SyncState;
  reviewLaunched: boolean;
  reviewError: string;
  onToday: () => void;
  onOpenDate: (date: string) => void;
  onChangeDate: (delta: number) => void;
  onUpdate: (patch: Partial<JournalEntry>) => void;
  onDelete: () => void;
  onOpenChatGpt: () => void;
}) {
  const blockTextareas = useRef(new Map<string, HTMLTextAreaElement>())
  const activeBlocks = useRef(new Set<string>())
  const lastInputAt = useRef(new Map<string, number>())
  const longPressTimer = useRef<number | undefined>(undefined)
  const movingBlockRef = useRef<string | null>(null)
  const dragStartY = useRef(0)
  const pointerStartY = useRef(0)
  const imageInput = useRef<HTMLInputElement>(null);
  const [tagInput, setTagInput] = useState("");
  const [imageError, setImageError] = useState("");
  const [focusMode, setFocusMode] = useState(false);
  const [movingBlockId, setMovingBlockId] = useState<string | null>(null)
  const [dragOffsetY, setDragOffsetY] = useState(0)
  const [draftContents, setDraftContents] = useState<Record<string, string>>({})
  const [composingBlockId, setComposingBlockId] = useState<string | null>(null)
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null)
  const hasEntry = hasEntryContent(entry);
  const blocks = entry.blocks
  const focusedBlock = focusedBlockId
    ? blocks.find((block) => block.id === focusedBlockId)
    : undefined
  const focusedBlockIndex = focusedBlock
    ? blocks.findIndex((block) => block.id === focusedBlock.id)
    : -1
  const writingPrompts = [
    "今天最重要的一件事",
    "我现在的感受",
    "明天想继续什么",
  ];

  useEffect(() => {
    setTagInput("")
    setImageError("")
    activeBlocks.current.clear()
    lastInputAt.current.clear()
    setDraftContents({})
    setComposingBlockId(null)
    setFocusedBlockId(null)
  }, [selectedDate])

  useEffect(() => {
    document.documentElement.toggleAttribute('data-writing-active', Boolean(focusedBlockId))
    return () => document.documentElement.removeAttribute('data-writing-active')
  }, [focusedBlockId])

  useEffect(() => {
    const endSessions = () => activeBlocks.current.clear()
    document.addEventListener('visibilitychange', endSessions)
    return () => document.removeEventListener('visibilitychange', endSessions)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (event.key === "Escape" && focusMode) setFocusMode(false);
      if (modifier && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFocusMode((value) => !value);
      }
      if (
        modifier &&
        event.key === "Enter" &&
        hasReviewableText(entry) &&
        syncState === "synced"
      ) {
        event.preventDefault();
        onOpenChatGpt();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusMode, entry, syncState, onOpenChatGpt]);

  function commitBlocks(nextBlocks: JournalBlock[]) {
    onUpdate({
      schemaVersion: 2,
      blocks: nextBlocks,
      content: journalBlocksToContent(nextBlocks),
    })
  }

  function updateBlockContent(blockId: string, content: string) {
    const now = new Date()
    const nowIso = now.toISOString()
    const previousInput = lastInputAt.current.get(blockId) || 0
    const startsSession =
      !activeBlocks.current.has(blockId) || now.getTime() - previousInput > 10 * 60 * 1000
    activeBlocks.current.add(blockId)
    lastInputAt.current.set(blockId, now.getTime())
    commitBlocks(
      blocks.map((block) => {
        if (block.id !== blockId) return block
        const writeStops = rebaseWriteStops(block.content, content, block.writeStops)
        const previousSessionIndex = block.writeTimes.length - 1
        if (
          startsSession &&
          previousInput &&
          previousSessionIndex >= 0 &&
          !writeStops.some((stop) => stop.sessionIndex === previousSessionIndex)
        ) {
          writeStops.push({
            sessionIndex: previousSessionIndex,
            offset: block.content.length,
            at: new Date(previousInput).toISOString(),
          })
        }
        return {
          ...block,
          content,
          updatedAt: nowIso,
          writeStops,
          writeTimes: startsSession
            ? [...block.writeTimes, nowIso]
            : block.writeTimes,
        }
      }),
    )
  }

  function finishBlockSession(blockId: string, content: string) {
    const block = blocks.find((item) => item.id === blockId)
    if (!block || !content.trim() || !block.writeTimes.length) return
    const sessionIndex = block.writeTimes.length - 1
    const nowIso = new Date().toISOString()
    const writeStop: JournalWriteStop = {
      sessionIndex,
      offset: content.length,
      at: nowIso,
    }
    commitBlocks(
      blocks.map((item) => item.id === blockId
        ? {
            ...item,
            content,
            updatedAt: nowIso,
            writeStops: [
              ...item.writeStops.filter((stop) => stop.sessionIndex !== sessionIndex),
              writeStop,
            ],
          }
        : item),
    )
  }

  function openBlockEditor(blockId: string, selection = 'end' as 'end' | 'start') {
    setFocusedBlockId(blockId)
    requestAnimationFrame(() => {
      const textarea = blockTextareas.current.get(blockId)
      if (!textarea) return
      textarea.focus()
      const position = selection === 'start' ? 0 : textarea.value.length
      textarea.setSelectionRange(position, position)
      growTextarea(textarea)
    })
  }

  function addBlock() {
    const block = createJournalBlock(selectedDate)
    setFocusedBlockId(block.id)
    commitBlocks([...blocks, block])
    requestAnimationFrame(() => blockTextareas.current.get(block.id)?.focus())
  }

  function removeBlock(blockId: string) {
    const block = blocks.find((item) => item.id === blockId)
    if (block?.content.trim() && !window.confirm('删除这一段记录？此操作无法撤销。')) {
      return
    }
    const nextBlocks = blocks.filter((block) => block.id !== blockId)
    commitBlocks(nextBlocks.length ? nextBlocks : [createJournalBlock(selectedDate)])
  }

  function moveBlock(blockId: string, targetId: string) {
    if (blockId === targetId) return
    const from = blocks.findIndex((block) => block.id === blockId)
    const to = blocks.findIndex((block) => block.id === targetId)
    if (from < 0 || to < 0) return
    const previousPositions = readBlockPositions()
    const nextBlocks = [...blocks]
    const [moving] = nextBlocks.splice(from, 1)
    nextBlocks.splice(to, 0, moving)
    commitBlocks(nextBlocks)
    animateBlockReorder(previousPositions)
  }

  function moveBlockBy(blockId: string, delta: number) {
    const index = blocks.findIndex((block) => block.id === blockId)
    const target = blocks[index + delta]
    if (target) moveBlock(blockId, target.id)
  }

  function startLongPress(blockId: string, event: React.PointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerStartY.current = event.clientY
    dragStartY.current = event.clientY
    window.clearTimeout(longPressTimer.current)
    longPressTimer.current = window.setTimeout(() => {
      movingBlockRef.current = blockId
      setMovingBlockId(blockId)
      setDragOffsetY(0)
      navigator.vibrate?.(30)
    }, 420)
  }

  function moveLongPress(event: React.PointerEvent<HTMLButtonElement>) {
    const moving = movingBlockRef.current
    if (!moving) {
      if (Math.abs(event.clientY - pointerStartY.current) > 8) {
        window.clearTimeout(longPressTimer.current)
      }
      return
    }
    setDragOffsetY(event.clientY - dragStartY.current)
    const target = Array.from(
      document.querySelectorAll<HTMLElement>('[data-block-id]'),
    ).find((element) => {
      if (element.dataset.blockId === moving) return false
      const rect = element.getBoundingClientRect()
      return event.clientY >= rect.top && event.clientY <= rect.bottom
    })?.dataset.blockId
    if (target) {
      moveBlock(moving, target)
      dragStartY.current = event.clientY
      setDragOffsetY(0)
    }
  }

  function endLongPress() {
    window.clearTimeout(longPressTimer.current)
    movingBlockRef.current = null
    setMovingBlockId(null)
    setDragOffsetY(0)
  }

  function applyInlineFormat(
    blockId: string,
    prefix: string,
    suffix: string,
    placeholder: string,
  ) {
    const block = blocks.find((item) => item.id === blockId)
    const textarea = blockTextareas.current.get(blockId)
    if (!block || !textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const currentContent = draftContents[blockId] ?? block.content
    const selected = currentContent.slice(start, end) || placeholder
    const content = `${currentContent.slice(0, start)}${prefix}${selected}${suffix}${currentContent.slice(end)}`
    setDraftContents((current) => ({ ...current, [blockId]: content }))
    updateBlockContent(blockId, content)
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(start + prefix.length, start + prefix.length + selected.length)
      growTextarea(textarea)
    })
  }

  function cycleBlockTextColor(blockId: string) {
    const colors: JournalTextColor[] = ['ink', 'sage', 'terracotta']
    const currentIndex = colors.indexOf(
      blocks.find((block) => block.id === blockId)?.textColor || 'ink',
    )
    const textColor = colors[(currentIndex + 1) % colors.length]
    commitBlocks(
      blocks.map((block) => block.id === blockId ? { ...block, textColor } : block),
    )
  }

  function addTag() {
    const value = tagInput.trim().replace(/^#/, "");
    if (value && !entry.tags.includes(value))
      onUpdate({ tags: [...entry.tags, value] });
    setTagInput("");
  }

  function renderMoodControls(compact = false) {
    return (
      <section className={`${compact ? 'entry-meta-compact' : 'side-card mood-card'}`}>
        <div className="card-title">
          <span>{compact ? '心情' : '今天感觉如何？'}</span>
          <small>{compact ? '可选' : '选择最接近的心情'}</small>
        </div>
        <div className="mood-row">
          {journalMoods.map((mood) => (
            <button
              key={mood.value}
              className={entry.mood === mood.value ? 'active' : ''}
              onClick={() => onUpdate({ mood: mood.value })}
              title={mood.label}
              aria-label={`${compact ? '快速选择' : ''}${mood.label}`}
              aria-pressed={entry.mood === mood.value}
            >
              {mood.emoji}
            </button>
          ))}
        </div>
        {!compact && (
          <div className="mood-selected">
            <span className="status-pulse" />
            {entry.mood
              ? `已选择：${journalMoods.find((mood) => mood.value === entry.mood)?.label}`
              : '还没有选择今天的感觉'}
          </div>
        )}
      </section>
    )
  }

  function renderTagControls(compact = false) {
    return (
      <section className={compact ? 'entry-meta-compact compact-tags' : 'side-card'}>
        <div className="card-title">
          <span><Tag />标签</span>
          <small>{compact ? '为日记留个线索' : '为日记留下线索'}</small>
        </div>
        <div className="tag-list">
          {entry.tags.map((tag) => (
            <button
              key={tag}
              aria-label={`移除标签 ${tag}`}
              onClick={() => onUpdate({ tags: entry.tags.filter((item) => item !== tag) })}
            >
              #{tag}<X />
            </button>
          ))}
        </div>
        <div className="tag-input">
          <input
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && addTag()}
            placeholder="添加标签"
            aria-label={compact ? '快速添加标签' : '添加标签'}
          />
          <button onClick={addTag} title="添加标签" aria-label={compact ? '快速确认标签' : '添加标签'}>
            <Plus />
          </button>
        </div>
      </section>
    )
  }

  async function addCoverImage(file?: File) {
    if (!file) return;
    setImageError("");
    try {
      const coverImage = await resizeJournalImage(file);
      onUpdate({ coverImage });
    } catch {
      setImageError("这张图片无法读取，请换一张试试。");
    } finally {
      if (imageInput.current) imageInput.current.value = "";
    }
  }

  return (
    <div className={`editor-layout ${focusMode ? "focus-mode" : ""}`}>
      <section className="writing-column">
        <div className="page-sheet">
        <span className="date-folio" aria-hidden="true">
          {format(parseISO(selectedDate), 'd')}
        </span>
        <span className="page-ribbon" aria-hidden="true" />
        <div className="date-heading">
          <div>
            <p>{format(parseISO(selectedDate), "EEEE", { locale: zhCN })}</p>
            <h1>
              {format(parseISO(selectedDate), "M月d日", { locale: zhCN })}
            </h1>
            <div className="date-subline">
              <span>
                {format(parseISO(selectedDate), "yyyy年")} ·{" "}
                {selectedDate === todayKey ? `今天 · ${timePhase()}` : "往日记录"}
              </span>
              <i className={hasEntry ? "recorded" : ""}>
                {hasEntry ? "已记录" : "新的一页"}
              </i>
              {selectedDate !== todayKey && (
                <button className="today-return" onClick={onToday}>
                  回到今天
                </button>
              )}
            </div>
          </div>
          <div className="date-actions">
            <button
              onClick={() => onChangeDate(-1)}
              aria-label="前一天"
              title="前一天"
            >
              <ChevronLeft />
            </button>
            <button
              onClick={() => onChangeDate(1)}
              aria-label="后一天"
              title="后一天"
            >
              <ChevronRight />
            </button>
            <button
              className="focus-toggle"
              onClick={() => setFocusMode((value) => !value)}
              aria-label={focusMode ? "退出专注写作" : "专注写作"}
              aria-keyshortcuts="Control+Shift+F Meta+Shift+F"
              title={
                focusMode
                  ? "退出专注写作（Esc）"
                  : "专注写作（Ctrl/⌘ + Shift + F）"
              }
            >
              {focusMode ? <Minimize2 /> : <Maximize2 />}
            </button>
          </div>
        </div>

        <div className="mobile-entry-meta">
          {renderMoodControls(true)}
          {renderTagControls(true)}
        </div>

        <div className="journal-title-card">
          <input
            className="title-input"
            value={entry.title}
            onChange={(event) => onUpdate({ title: event.target.value })}
            placeholder="给今天起个标题…"
            aria-label="日记标题"
          />
          <input
            ref={imageInput}
            className="visually-hidden"
            type="file"
            accept="image/*"
            onChange={(event) => void addCoverImage(event.target.files?.[0])}
            aria-label="选择日记照片"
          />
          {entry.coverImage ? (
            <figure className="entry-cover">
              <img src={entry.coverImage} alt="这篇日记的照片" />
              <button
                onClick={() => onUpdate({ coverImage: undefined })}
                aria-label="移除日记照片"
                title="移除照片"
              >
                <X />
              </button>
            </figure>
          ) : (
            <button
              className="add-photo"
              onClick={() => imageInput.current?.click()}
            >
              <ImagePlus />
              添加照片 <small>可选</small>
            </button>
          )}
          {imageError && (
            <span className="image-error" role="alert">
              {imageError}
            </span>
          )}
        </div>

        <div className="journal-block-list">
          {!entry.content.trim() && blocks.length === 1 && (
            <div className="prompt-strip" role="group" aria-label="写作提示">
              <span>从一个念头开始</span>
              {writingPrompts.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => {
                    updateBlockContent(blocks[0].id, `${prompt}：\n\n`)
                    requestAnimationFrame(() => {
                      const textarea = blockTextareas.current.get(blocks[0].id)
                      textarea?.focus()
                      textarea?.setSelectionRange(
                        prompt.length + 2,
                        prompt.length + 2,
                      )
                    })
                  }}
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}
          {blocks.map((block, index) => (
            <article
              key={block.id}
              className={`journal-block ${movingBlockId === block.id ? 'is-moving' : ''}`}
              data-block-id={block.id}
              data-text-color={block.textColor || 'ink'}
              style={movingBlockId === block.id
                ? { '--drag-y': `${dragOffsetY}px` } as React.CSSProperties
                : undefined}
            >
              <header className="journal-block-header">
                <div className="record-tile-heading">
                  <span className="record-tile-label">记录片 {index + 1}</span>
                  {block.writeTimes[0] ? (
                    <time dateTime={block.writeTimes[0]}>
                      <Clock3 />开始 {format(parseISO(block.writeTimes[0]), 'HH:mm:ss')}
                    </time>
                  ) : (
                    <small>开始输入后计时</small>
                  )}
                </div>
                <div className="journal-block-tools">
                  <button
                    onClick={() => moveBlockBy(block.id, -1)}
                    disabled={index === 0}
                    aria-label={`上移第 ${index + 1} 段`}
                  ><ChevronUp /></button>
                  <button
                    onClick={() => moveBlockBy(block.id, 1)}
                    disabled={index === blocks.length - 1}
                    aria-label={`下移第 ${index + 1} 段`}
                  ><ChevronDown /></button>
                  <button
                    className="block-grip"
                    onPointerDown={(event) => startLongPress(block.id, event)}
                    onPointerMove={moveLongPress}
                    onPointerUp={endLongPress}
                    onPointerCancel={endLongPress}
                    aria-label={`长按移动第 ${index + 1} 段`}
                  ><GripVertical /></button>
                  <button
                    onClick={() => removeBlock(block.id)}
                    aria-label={`删除第 ${index + 1} 段`}
                  ><Trash2 /></button>
                </div>
              </header>
              {focusedBlockId === block.id || !block.content ? (
                <textarea
                ref={(element) => {
                  if (element) {
                    blockTextareas.current.set(block.id, element)
                    if (element.value) growTextarea(element)
                  }
                  else blockTextareas.current.delete(block.id)
                }}
                value={draftContents[block.id] ?? block.content}
                onFocus={() => setFocusedBlockId(block.id)}
                onChange={(event) => {
                  const content = event.target.value
                  setDraftContents((current) => ({ ...current, [block.id]: content }))
                  if (!(event.nativeEvent as InputEvent).isComposing) {
                    updateBlockContent(block.id, content)
                  }
                  const element = event.currentTarget
                  requestAnimationFrame(() => growTextarea(element))
                }}
                onCompositionStart={() => setComposingBlockId(block.id)}
                onCompositionEnd={(event) => {
                  const element = event.currentTarget
                  const content = element.value
                  setComposingBlockId(null)
                  setDraftContents((current) => ({ ...current, [block.id]: content }))
                  updateBlockContent(block.id, content)
                  requestAnimationFrame(() => growTextarea(element))
                }}
                onBlur={(event) => {
                  const content = event.currentTarget.value
                  const wasActive = activeBlocks.current.has(block.id)
                  activeBlocks.current.delete(block.id)
                  fitTextarea(event.currentTarget)
                  if (wasActive) finishBlockSession(block.id, content)
                  setFocusedBlockId(null)
                }}
                aria-label={index === 0 ? '日记正文' : `日记正文第 ${index + 1} 段`}
                placeholder={index === 0
                  ? '此刻，你想记住什么？不必完整，也不用完美。'
                  : '继续写下这个时刻……'}
                />
              ) : (
                <div
                  className="journal-block-readable"
                  role="textbox"
                  tabIndex={0}
                  aria-label={index === 0 ? '日记正文' : `日记正文第 ${index + 1} 段`}
                  aria-readonly="true"
                  onClick={() => openBlockEditor(block.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      openBlockEditor(block.id)
                    }
                  }}
                >
                  {renderTimedBlockText(block)}
                </div>
              )}
              <footer className="journal-block-footer">
                <div className="journal-block-footer-actions">
                  <span>{block.content.replace(/\s/g, '').length} 字</span>
                  <button onClick={() => openBlockEditor(block.id)}>继续写这一段</button>
                </div>
              </footer>
            </article>
          ))}
          <button className="add-journal-block" onClick={addBlock}>
            <Plus />另起一段
          </button>
          {hasEntry && (
            <button className="delete-entry-button" onClick={onDelete}>
              <Trash2 />删除整篇
            </button>
          )}
          <div className="editor-footer">
            <time
              className={`editor-save ${saveState}`}
              dateTime={entry.updatedAt || entry.createdAt}
            >
              <Clock3 />
              {saveState === 'saving'
                ? '正在保存…'
                : saveState === 'error'
                  ? '尚未保存到本机 · 当前页面仍保留'
                  : `已自动保存 · ${format(parseISO(entry.updatedAt || entry.createdAt), 'HH:mm')}`}
            </time>
            <span className="word-count">共 {wordCount} 字 · {blocks.length} 段</span>
          </div>
        </div>
        {focusedBlock && focusedBlockIndex >= 0 && createPortal(
            <div className="keyboard-format-toolbar" role="toolbar" aria-label="输入法上方文字工具">
              <span>记录片 {focusedBlockIndex + 1}</span>
              <button
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => applyInlineFormat(focusedBlock.id, '**', '**', '加粗文字')}
                aria-label={`加粗第 ${focusedBlockIndex + 1} 段所选文字`}
                disabled={composingBlockId === focusedBlock.id}
              ><Bold /></button>
              <button
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => applyInlineFormat(focusedBlock.id, '*', '*', '斜体文字')}
                aria-label={`斜体第 ${focusedBlockIndex + 1} 段所选文字`}
                disabled={composingBlockId === focusedBlock.id}
              ><Italic /></button>
              <button
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => cycleBlockTextColor(focusedBlock.id)}
                aria-label={`切换第 ${focusedBlockIndex + 1} 段文字颜色`}
                disabled={composingBlockId === focusedBlock.id}
              ><Palette /></button>
              <button
                className="keyboard-toolbar-done"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => blockTextareas.current.get(focusedBlock.id)?.blur()}
              ><Check />完成</button>
            </div>,
            document.body,
          )}
        </div>
      </section>

      <aside className="insight-column">
        <div className="desktop-entry-meta">
          {renderMoodControls()}
          {renderTagControls()}
        </div>

        <section className="memory-card" aria-label="往年今日（时间回声）">
          <div className="memory-card-title">
            <span>
              <CalendarDays />
              往年今日
            </span>
            <small>往年同日回看</small>
          </div>
          {memoryEntries.length ? (
            <div className="memory-list">
              {memoryEntries.map((memory) => (
                <button
                  key={memory.date}
                  onClick={() => onOpenDate(memory.date)}
                  aria-label={`打开 ${memory.date} 的日记`}
                >
                  <time dateTime={memory.date}>
                    {format(parseISO(memory.date), 'yyyy')}
                  </time>
                  <span>
                    <strong>{memory.title || '那一天的片段'}</strong>
                    <small>
                      {journalPreviewText(memory.content).slice(0, 42) ||
                        '这一天留下了一张照片。'}
                    </small>
                  </span>
                  <ArrowUpRight />
                </button>
              ))}
            </div>
          ) : (
            <div className="memory-empty">
              <strong>这里会出现过去的今天</strong>
              <p>如果过去某年的同一天写过日记，会显示在这里，点按即可回看。</p>
            </div>
          )}
        </section>

        <section className="ai-card">
          <div className="ai-icon">
            <Bot />
          </div>
          <div>
            <small className={`ai-status ${syncState}`}>
              <span />
              {syncState === 'synced'
                ? '可以开始复盘'
                : '同步状态请看顶部'}
            </small>
            <h3>从今天，看见自己</h3>
            <p>
              {syncState === "offline"
                ? "日记已保存在本机，网络恢复后会自动同步，再交给 ChatGPT 复盘。"
                : "完成记录后，让 ChatGPT 读取日记并给出一份诚实、温和的复盘。"}
            </p>
          </div>
          <div className={`ai-flow ${syncState}`} aria-label="AI 复盘处理链路">
            <span className="active">日记</span>
            <i aria-hidden="true">→</i>
            <span className={syncState === "synced" ? "active" : ""}>MCP</span>
            <i aria-hidden="true">→</i>
            <span className={syncState === "synced" ? "active" : ""}>复盘</span>
          </div>
          <button
            className={reviewLaunched ? "review-done" : ""}
            onClick={onOpenChatGpt}
            disabled={!hasReviewableText(entry) || syncState !== "synced"}
          >
            {reviewLaunched ? <Check /> : <Sparkles />}
            {reviewLaunched
              ? "提示词已复制"
              : !hasReviewableText(entry)
                ? "先写一点再复盘"
                : syncState === 'synced'
                  ? '让 ChatGPT 复盘'
                  : '同步后可复盘'}
          </button>
          <span role={reviewError ? "alert" : undefined}>
            {reviewError ||
              (reviewLaunched
                ? "复盘提示词已复制，将固定打开“日记”项目"
                : "点击复盘时会复制提示词并打开“日记”项目")}
          </span>
        </section>

        <blockquote>“记录不是为了留住每一天，而是为了不丢失自己。”</blockquote>
      </aside>
    </div>
  );
}
