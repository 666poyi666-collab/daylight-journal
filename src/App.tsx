import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  CalendarRange,
  Check,
  LibraryBig,
  Menu,
  Moon,
  NotebookPen,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Sun,
  X,
} from 'lucide-react'
import {
  addMonths,
  addDays,
  format,
  parseISO,
  startOfMonth,
  subMonths,
  subDays,
} from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { useMediaQuery } from './hooks/useMediaQuery.ts'
import { useTodayKey } from './hooks/useTodayKey.ts'
import { CalendarPage } from './pages/CalendarPage.tsx'
import { EditorPage } from './pages/EditorPage.tsx'
import { HistoryPage } from './pages/HistoryPage.tsx'
import { SettingsPage } from './pages/SettingsPage.tsx'
import {
  applyEntryPatch,
  emptyEntry,
  hasEntryContent,
  hasReviewableText,
  type JournalEntries,
  type JournalEntry,
} from './journal/model.ts'
import {
  SETTINGS_KEY,
  getBrowserStorage,
  loadJournalEntries,
  persistJournalEntries,
  preserveRecoveryValue,
  readStorageValue,
  writeStorageValue,
  type StorageIssue,
} from './journal/storage.ts'
import type { SaveState, SyncState } from './journal/status.ts'
import { buildReviewPrompt } from './journal/review.ts'
import {
  initializeRootKey,
  parseRootKey,
  serializeRootKey,
  type RootKeyBundle,
} from './journal/encrypted-sync.ts'
import {
  BrowserSyncStore,
  JOURNAL_ROOT_KEY_STORAGE_KEY,
  JournalV2SyncClient,
  deviceIdFromToken,
} from './journal/v2-sync.ts'
import './editorial-ui.css'

type View = 'today' | 'calendar' | 'history' | 'settings'

const JOURNAL_API_URL_KEY = 'daylight-journal-api'
const JOURNAL_API_TOKEN_KEY = 'daylight-journal-api-token'
const DEFAULT_JOURNAL_API =
  import.meta.env.VITE_JOURNAL_API_URL ||
  readStorageValue(JOURNAL_API_URL_KEY) ||
  'http://127.0.0.1:8780'
const CHATGPT_PROJECT_URL =
  import.meta.env.VITE_CHATGPT_PROJECT_URL || 'https://chatgpt.com/'
const SPLASH_SESSION_KEY = 'daylight-splash-seen'

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null
  } catch {
    return null
  }
}

const navItems = [
  { id: 'today' as View, label: '今日', icon: NotebookPen },
  { id: 'calendar' as View, label: '日历', icon: CalendarRange },
  { id: 'history' as View, label: '历史', icon: LibraryBig },
]

interface ViewScrollPosition {
  documentTop: number
  stageTop: number
  writingTop: number
  insightTop: number
}

function App() {
  const todayKey = useTodayKey()
  const compactNavigation = useMediaQuery(
    '(max-width: 699px), (orientation: landscape) and (max-width: 820px)',
  )
  const [initialLoad] = useState(loadJournalEntries)
  const [view, setView] = useState<View>('today')
  const [entries, setEntries] = useState<JournalEntries>(initialLoad.entries)
  const [selectedDate, setSelectedDate] = useState(todayKey)
  const [calendarMonth, setCalendarMonth] = useState(startOfMonth(new Date()))
  const [search, setSearch] = useState('')
  const [mobileMenu, setMobileMenu] = useState(false)
  const [splashVisible, setSplashVisible] = useState(() => {
    try {
      return sessionStorage.getItem(SPLASH_SESSION_KEY) !== '1'
    } catch {
      return true
    }
  })
  const [dark, setDark] = useState(
    () => readStorageValue('daylight-theme') === 'dark',
  )
  const [saveState, setSaveState] = useState<SaveState>(
    initialLoad.issue ? 'error' : 'saved',
  )
  const [storageIssue, setStorageIssue] = useState<StorageIssue | null>(
    initialLoad.issue,
  )
  const [syncState, setSyncState] = useState<SyncState>('syncing')
  const [journalApiUrl, setJournalApiUrl] = useState(DEFAULT_JOURNAL_API)
  const [journalApiToken, setJournalApiToken] = useState(
    () => readStorageValue(JOURNAL_API_TOKEN_KEY) || '',
  )
  const [journalRootKey, setJournalRootKey] = useState<RootKeyBundle | null>(
    () => parseRootKey(readStorageValue(JOURNAL_ROOT_KEY_STORAGE_KEY) || ''),
  )
  const [reviewLaunched, setReviewLaunched] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [chatGptUrl, setChatGptUrl] = useState(() => {
    try {
      const saved = JSON.parse(
        readStorageValue(SETTINGS_KEY) || '{}',
      ).chatGptUrl
      return saved && saved !== "https://chatgpt.com/"
        ? saved
        : CHATGPT_PROJECT_URL
    } catch {
      return CHATGPT_PROJECT_URL
    }
  })
  const saveTimer = useRef<number | undefined>(undefined)
  const reviewTimer = useRef<number | undefined>(undefined)
  const syncInFlight = useRef<{ epoch: number; promise: Promise<boolean> } | null>(null)
  const syncConfigEpochRef = useRef(0)
  const revisionRef = useRef(0)
  const syncedRevisionRef = useRef(-1)
  const recoveryRawRef = useRef(initialLoad.raw)
  const entriesRef = useRef(entries)
  const sidebarRef = useRef<HTMLElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const previousTodayRef = useRef(todayKey)
  const scrollPositionsRef = useRef(new Map<View, ViewScrollPosition>())
  const pendingScrollRestoreRef = useRef<{ view: View; reset: boolean } | null>(null)

  const entry = entries[selectedDate] || emptyEntry(selectedDate)
  const hasCurrentEntry = hasEntryContent(entry)
  const reviewReady = hasReviewableText(entry) && syncState === 'synced'
  const sortedEntries = useMemo(
    () =>
      Object.values(entries)
        .filter(hasEntryContent)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [entries],
  );
  const memoryEntries = useMemo(
    () =>
      sortedEntries
        .filter(
          (item) =>
            item.date !== selectedDate &&
            item.date.slice(5) === selectedDate.slice(5),
        )
        .slice(0, 2),
    [selectedDate, sortedEntries],
  )

  useEffect(() => {
    if (!splashVisible) return
    try {
      sessionStorage.setItem(SPLASH_SESSION_KEY, '1')
    } catch {
      // A blocked session store must not prevent the app from opening.
    }
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(
      () => setSplashVisible(false),
      reduceMotion ? 140 : 1080,
    )
    return () => window.clearTimeout(timer)
  }, [splashVisible])

  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current
    if (!pending || pending.view !== view) return
    pendingScrollRestoreRef.current = null
    const saved = pending.reset ? undefined : scrollPositionsRef.current.get(view)
    requestAnimationFrame(() => {
      const documentTop = saved?.documentTop ?? 0
      window.scrollTo({ top: documentTop, behavior: 'auto' })
      document.querySelector<HTMLElement>('.view-stage')?.scrollTo({
        top: saved?.stageTop ?? 0,
        behavior: 'auto',
      })
      document.querySelector<HTMLElement>('.writing-column')?.scrollTo({
        top: saved?.writingTop ?? 0,
        behavior: 'auto',
      })
      document.querySelector<HTMLElement>('.insight-column')?.scrollTo({
        top: saved?.insightTop ?? 0,
        behavior: 'auto',
      })
    })
  }, [view])

  useEffect(() => {
    const updateKeyboardInputState = () => {
      requestAnimationFrame(() => {
        const active = document.activeElement
        const acceptsText = active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          (active instanceof HTMLElement && active.isContentEditable)
        document.documentElement.toggleAttribute('data-keyboard-input', acceptsText)
      })
    }
    document.addEventListener('focusin', updateKeyboardInputState)
    document.addEventListener('focusout', updateKeyboardInputState)
    return () => {
      document.removeEventListener('focusin', updateKeyboardInputState)
      document.removeEventListener('focusout', updateKeyboardInputState)
      document.documentElement.removeAttribute('data-keyboard-input')
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    writeStorageValue('daylight-theme', dark ? 'dark' : 'light')
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', dark ? '#111813' : '#526f5c')
  }, [dark]);

  const persistSnapshot = useCallback((snapshot: JournalEntries) => {
    if (recoveryRawRef.current) {
      const recovery = preserveRecoveryValue(recoveryRawRef.current)
      if (!recovery.ok) {
        setStorageIssue(recovery.issue)
        return recovery
      }
      recoveryRawRef.current = null
    }
    const result = persistJournalEntries(snapshot)
    setStorageIssue(result.ok ? null : result.issue)
    return result
  }, [])

  useEffect(() => {
    if (journalRootKey) return
    let cancelled = false
    void initializeRootKey().then((bundle) => {
      if (cancelled) return
      const result = writeStorageValue(
        JOURNAL_ROOT_KEY_STORAGE_KEY,
        serializeRootKey(bundle),
      )
      if (!result.ok) {
        setStorageIssue(result.issue)
        setSyncState('offline')
        return
      }
      setJournalRootKey(bundle)
    })
    return () => {
      cancelled = true
    }
  }, [journalRootKey])

  const createSyncClient = useCallback(() => {
    const storage = getBrowserStorage()
    const deviceId = deviceIdFromToken(journalApiToken)
    if (!storage || !deviceId || !journalRootKey) throw new Error('sync_not_configured')
    return new JournalV2SyncClient({
      baseUrl: journalApiUrl,
      deviceToken: journalApiToken,
      rootKey: journalRootKey,
      store: new BrowserSyncStore(storage, journalApiUrl, deviceId),
    })
  }, [journalApiToken, journalApiUrl, journalRootKey])

  useEffect(() => {
    if (selectedDate === previousTodayRef.current) setSelectedDate(todayKey)
    previousTodayRef.current = todayKey
  }, [selectedDate, todayKey])

  const synchronize = useCallback(async (): Promise<boolean> => {
    const epoch = syncConfigEpochRef.current
    const active = syncInFlight.current
    if (active?.epoch === epoch) return active.promise
    if (active) await active.promise
    if (epoch !== syncConfigEpochRef.current) return false
    const run = (async () => {
      setSyncState('syncing')
      try {
        const startedAtRevision = revisionRef.current
        const client = createSyncClient()
        const result = await client.synchronize(entriesRef.current)
        if (epoch !== syncConfigEpochRef.current || startedAtRevision !== revisionRef.current) return true
        entriesRef.current = result.entries
        setEntries(result.entries)
        const persisted = persistSnapshot(result.entries)
        if (!persisted.ok) setSaveState('error')
        else setSaveState('saved')
        syncedRevisionRef.current = startedAtRevision
        setSyncState('synced')
        return true
      } catch {
        if (epoch === syncConfigEpochRef.current) setSyncState('offline')
        return false
      }
    })()
    syncInFlight.current = { epoch, promise: run }
    try {
      return await run
    } finally {
      if (syncInFlight.current?.promise === run) syncInFlight.current = null
    }
  }, [createSyncClient, persistSnapshot])

  const flushLatestEntries = useCallback(async () => {
    let attemptedRevision = -1
    while (attemptedRevision !== revisionRef.current) {
      attemptedRevision = revisionRef.current
      const ok = await synchronize()
      if (!ok) return false
    }
    return true
  }, [synchronize])

  useEffect(() => {
    if (!journalRootKey) return
    void flushLatestEntries()
    const retry = () => void flushLatestEntries()
    const resume = () => {
      if (document.visibilityState === "visible") void flushLatestEntries()
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void flushLatestEntries()
    }, 30_000);
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [flushLatestEntries, journalRootKey]);

  useEffect(() => {
    return () => {
      window.clearTimeout(saveTimer.current)
      window.clearTimeout(reviewTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!mobileMenu) return;
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const focusable = () =>
      Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'button, input, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
    const frame = requestAnimationFrame(() => focusable()[0]?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileMenu(false)
        menuTriggerRef.current?.focus()
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    };
    sidebar.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      sidebar.removeEventListener('keydown', onKeyDown)
    }
  }, [mobileMenu]);

  useEffect(() => {
    const sidebar = sidebarRef.current
    if (!sidebar) return
    const hidden = compactNavigation && !mobileMenu
    sidebar.toggleAttribute('inert', hidden)
    return () => {
      sidebar.toggleAttribute('inert', false)
    }
  }, [compactNavigation, mobileMenu])

  useEffect(() => {
    if (!compactNavigation) setMobileMenu(false)
  }, [compactNavigation])

  function updateEntry(date: string, patch: Partial<JournalEntry>) {
    const next = applyEntryPatch(entriesRef.current, date, patch)
    entriesRef.current = next
    revisionRef.current += 1
    setEntries(next)
    setSaveState('saving')
    const persisted = persistSnapshot(next)
    setSaveState(persisted.ok ? 'saved' : 'error')
    setSyncState('syncing')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void flushLatestEntries()
    }, 500)
  }

  async function deleteEntry(date: string) {
    if (!hasEntryContent(entriesRef.current[date])) return
    if (!window.confirm('删除整篇日记？删除会同步到其他设备，之后仍可在同一天重新写作。')) return
    setSyncState('syncing')
    try {
      await createSyncClient().queueDelete(date)
      const next = { ...entriesRef.current }
      delete next[date]
      entriesRef.current = next
      revisionRef.current += 1
      setEntries(next)
      const persisted = persistSnapshot(next)
      setSaveState(persisted.ok ? 'saved' : 'error')
      await flushLatestEntries()
    } catch {
      setSyncState('offline')
    }
  }

  function captureScrollPosition(currentView: View) {
    scrollPositionsRef.current.set(currentView, {
      documentTop: document.scrollingElement?.scrollTop ?? 0,
      stageTop: document.querySelector<HTMLElement>('.view-stage')?.scrollTop ?? 0,
      writingTop: document.querySelector<HTMLElement>('.writing-column')?.scrollTop ?? 0,
      insightTop: document.querySelector<HTMLElement>('.insight-column')?.scrollTop ?? 0,
    })
  }

  function scrollCurrentViewToTop() {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth'
    window.scrollTo({ top: 0, behavior })
    document.querySelector<HTMLElement>('.view-stage')?.scrollTo({ top: 0, behavior })
    document.querySelector<HTMLElement>('.writing-column')?.scrollTo({ top: 0, behavior })
  }

  function navigate(nextView: View, reset = false) {
    if (nextView === view) {
      scrollCurrentViewToTop()
      setMobileMenu(false)
      return
    }
    captureScrollPosition(view)
    pendingScrollRestoreRef.current = { view: nextView, reset }
    setView(nextView)
    if (nextView === 'today') setSelectedDate(todayKey)
    setMobileMenu(false)
  }

  function openDate(date: string) {
    setSelectedDate(date)
    if (view === 'today') {
      scrollCurrentViewToTop()
      return
    }
    navigate('today', true)
  }

  async function openChatGpt() {
    if (!hasReviewableText(entry)) return
    setReviewError('')
    const target = safeHttpUrl(chatGptUrl || CHATGPT_PROJECT_URL)
    if (!target) {
      setReviewError('ChatGPT 项目地址无效，请先在设置中检查。')
      return
    }
    const popup = window.open('about:blank', '_blank')
    if (popup) popup.opener = null
    const synced = await flushLatestEntries()
    if (!synced) {
      popup?.close()
      setReviewError('日记同步失败，已保留本机稿件，请联网后重试。')
      return
    }
    const prompt = buildReviewPrompt(selectedDate)
    let copied = false
    if (navigator.clipboard) {
      copied = await navigator.clipboard.writeText(prompt).then(
        () => true,
        () => false,
      )
    }
    let opened = Boolean(popup)
    try {
      if (popup) popup.location.replace(target)
      else opened = Boolean(window.open(target, '_blank', 'noopener,noreferrer'))
    } catch {
      popup?.close()
      opened = false
    }
    if (!opened) {
      setReviewError('浏览器拦截了新窗口，请允许弹窗后重试。')
      return
    }
    if (!copied) {
      setReviewError('已打开 ChatGPT，但提示词复制失败，请检查剪贴板权限。')
      return
    }
    setReviewLaunched(true)
    window.clearTimeout(reviewTimer.current)
    reviewTimer.current = window.setTimeout(() => setReviewLaunched(false), 2600)
  }

  const wordCount = entry.content.replace(/\s/g, '').length
  const { currentMonthCount, totalWordCount, currentStreak } = useMemo(() => {
    const currentMonthPrefix = format(new Date(), 'yyyy-MM')
    const currentMonthCount = sortedEntries.filter((item) =>
      item.date.startsWith(currentMonthPrefix),
    ).length
    const totalWordCount = sortedEntries.reduce(
      (sum, item) => sum + item.content.replace(/\s/g, '').length,
      0,
    )
    let currentStreak = 0
    let streakDate = todayKey
    while (hasEntryContent(entries[streakDate])) {
      currentStreak += 1
      streakDate = format(subDays(parseISO(streakDate), 1), 'yyyy-MM-dd')
    }
    return { currentMonthCount, totalWordCount, currentStreak }
  }, [entries, sortedEntries, todayKey])

  return (
    <>
      {splashVisible && (
        <button
          className="product-splash"
          type="button"
          onClick={() => setSplashVisible(false)}
          aria-label="跳过启动动画"
        >
          <span className="product-splash-mark" aria-hidden="true">
            <img src="/icon-journal-sunrise.png" alt="" />
            <i />
          </span>
          <strong>拾光</strong>
          <small>DAYLIGHT JOURNAL</small>
          <span className="product-splash-line" aria-hidden="true"><i /></span>
          <em>记录此刻，看见自己</em>
        </button>
      )}
      <div className="app-shell">
        <aside
          ref={sidebarRef}
          id="journal-navigation"
          className={`sidebar ${mobileMenu ? "is-open" : ""}`}
          aria-label="日记导航"
          aria-hidden={compactNavigation && !mobileMenu ? true : undefined}
        >
          <div className="brand">
            <div className="brand-mark">
              <img src="/icon-journal-sunrise.png" alt="" />
            </div>
            <div>
              <strong>拾光</strong>
              <span>Daylight Journal</span>
            </div>
            <button
              className="icon-button mobile-close"
              onClick={() => setMobileMenu(false)}
              aria-label="关闭菜单"
              aria-keyshortcuts="Escape"
            >
              <X />
            </button>
          </div>

          <button className="new-entry" onClick={() => openDate(todayKey)}>
            <Plus size={18} />
            写下今天
          </button>

          <div className="sidebar-pulse" aria-label="记录概览">
            <span>
              <strong>{currentMonthCount}</strong>
              本月
            </span>
            <i />
            <span>
              <strong>{totalWordCount.toLocaleString()}</strong>
              累计字数
            </span>
          </div>
          {currentStreak > 0 && (
            <div
              className="sidebar-streak"
              aria-label={`连续记录 ${currentStreak} 天`}
            >
              <Sparkles size={12} />
              <span>
                <strong>{currentStreak} 天</strong> 连续记录
              </span>
            </div>
          )}

          <nav className="primary-nav">
            <p className="nav-label">日记</p>
            {navItems.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={view === id ? "active" : ""}
                onClick={() => navigate(id)}
                aria-current={view === id ? 'page' : undefined}
              >
                <span className="nav-icon-frame" aria-hidden="true">
                  <Icon />
                </span>
                <span>{label}</span>
                {id === "history" && sortedEntries.length > 0 && (
                  <em>{sortedEntries.length}</em>
                )}
              </button>
            ))}
          </nav>

          <div className="recent-list">
            <p className="nav-label">最近记录</p>
            {sortedEntries.slice(0, 12).map((item) => (
              <button
                key={item.date}
                onClick={() => openDate(item.date)}
                className={
                  item.date === selectedDate && view === "today" ? "active" : ""
                }
              >
                <span className="recent-dot" />
                <span>
                  <strong>
                    {item.title ||
                      format(parseISO(item.date), "M月d日", { locale: zhCN })}
                  </strong>
                  <small>{item.content.slice(0, 18) || "一篇安静的记录"}</small>
                </span>
              </button>
            ))}
            {sortedEntries.length === 0 && (
              <div className="sidebar-empty">第一篇日记，从今天开始。</div>
            )}
          </div>

          <div className="sidebar-footer">
            <button
              onClick={() => navigate("settings")}
              className={view === "settings" ? "active" : ""}
              aria-current={view === 'settings' ? 'page' : undefined}
            >
              <span className="nav-icon-frame" aria-hidden="true">
                <SlidersHorizontal />
              </span>
              设置
            </button>
            <button
              onClick={() => setDark((value) => !value)}
              aria-label={dark ? '切换到浅色模式' : '切换到深色模式'}
              aria-pressed={dark}
            >
              <span className="nav-icon-frame" aria-hidden="true">
                {dark ? <Sun /> : <Moon />}
              </span>
              {dark ? "浅色模式" : "深色模式"}
            </button>
          </div>
        </aside>

        {mobileMenu && (
          <button
            className="backdrop"
            onClick={() => setMobileMenu(false)}
            aria-label="关闭菜单"
          />
        )}

        <main className="main-area">
          <header className="topbar">
            <button
              ref={menuTriggerRef}
              className="icon-button menu-button"
              onClick={() => setMobileMenu(true)}
              aria-label="打开菜单"
              aria-expanded={mobileMenu}
              aria-controls="journal-navigation"
            >
              <Menu />
            </button>
            <div className="topbar-title">
              <span>
                {view === "today"
                  ? "我的日记"
                  : view === "calendar"
                    ? "日历"
                    : view === "history"
                      ? "历史记录"
                      : "设置"}
              </span>
              {view === "today" &&
                (saveState === "error" ? (
                  <small className="sync-status offline" role="alert">
                    {storageIssue === "unavailable"
                      ? "本地存储不可用 · 草稿留在当前页面"
                      : storageIssue === "corrupt" || storageIssue === "invalid-data"
                        ? "检测到旧数据异常 · 已保留恢复副本"
                        : "尚未保存到本机 · 请检查存储空间"}
                  </small>
                ) : syncState === "offline" && saveState !== "saving" ? (
                  <button
                    className="sync-status offline retryable"
                    onClick={() => void synchronize()}
                    aria-live="polite"
                    aria-label="重试同步"
                    title="点击重试同步"
                  >
                    已保存到本机 · 点击重试
                  </button>
                ) : (
                  <small
                    className={`sync-status ${saveState === "saving" ? "saving" : syncState}`}
                    aria-live="polite"
                  >
                    {saveState === "saving"
                      ? "正在保存…"
                      : syncState === "syncing"
                        ? "正在同步…"
                        : "已保存并同步"}
                  </small>
                ))}
            </div>
            <div className="topbar-actions">
              <button
                className="icon-button"
                onClick={() => setDark((value) => !value)}
                aria-label={dark ? '切换到浅色模式' : '切换到深色模式'}
                aria-pressed={dark}
              >
                {dark ? <Sun /> : <Moon />}
              </button>
              {view === "today" && (
                <button
                  className={`chat-mini ${syncState} ${reviewLaunched ? "review-done" : ""} ${reviewReady ? "" : "is-disabled"}`}
                  onClick={openChatGpt}
                  disabled={!reviewReady}
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  title={
                    !hasCurrentEntry
                      ? "先写一点日记，再开始复盘"
                      : syncState === "synced"
                        ? "打开 ChatGPT 日记项目（Ctrl/⌘ + Enter）"
                        : "等待日记同步完成后再复盘"
                  }
                >
                  {reviewLaunched ? (
                    <Check size={16} />
                  ) : (
                    <Sparkles size={16} />
                  )}
                  {reviewLaunched
                    ? '已复制 · 已打开'
                    : reviewError
                      ? '重试 AI 复盘'
                      : !hasReviewableText(entry)
                        ? '先写一点'
                        : 'AI 复盘'}
                </button>
              )}
            </div>
          </header>

          <div
            key={view}
            className={`view-stage ${view === 'today' ? 'editor-stage' : ''}`}
          >
            {view === "today" && (
              <EditorPage
                entry={entry}
                memoryEntries={memoryEntries}
                selectedDate={selectedDate}
                todayKey={todayKey}
                wordCount={wordCount}
                saveState={saveState}
                syncState={syncState}
                reviewLaunched={reviewLaunched}
                reviewError={reviewError}
                onToday={() => setSelectedDate(todayKey)}
                onOpenDate={openDate}
                onChangeDate={(delta) =>
                  setSelectedDate(
                    format(
                      delta > 0
                        ? addDays(parseISO(selectedDate), 1)
                        : subDays(parseISO(selectedDate), 1),
                      "yyyy-MM-dd",
                    ),
                  )
                }
                onUpdate={(patch) => updateEntry(selectedDate, patch)}
                onDelete={() => void deleteEntry(selectedDate)}
                onOpenChatGpt={openChatGpt}
              />
            )}
            {view === "calendar" && (
              <CalendarPage
                month={calendarMonth}
                entries={entries}
                selectedDate={selectedDate}
                onPrevious={() => setCalendarMonth(subMonths(calendarMonth, 1))}
                onNext={() => setCalendarMonth(addMonths(calendarMonth, 1))}
                onToday={() => setCalendarMonth(startOfMonth(new Date()))}
                onOpen={openDate}
              />
            )}
            {view === "history" && (
              <HistoryPage
                entries={sortedEntries}
                search={search}
                onSearch={setSearch}
                onOpen={openDate}
                onWrite={() => openDate(todayKey)}
              />
            )}
            {view === "settings" && (
              <SettingsPage
                chatGptUrl={chatGptUrl}
                defaultChatGptUrl={CHATGPT_PROJECT_URL}
                journalApiUrl={journalApiUrl}
                journalApiToken={journalApiToken}
                journalRootKey={journalRootKey ? serializeRootKey(journalRootKey) : ''}
                syncState={syncState}
                onCheckConnection={synchronize}
                onSyncConfig={(url, token, rootKeyValue) => {
                  const normalizedUrl = safeHttpUrl(url)
                  const normalizedToken = token.trim()
                  const normalizedRootKey = parseRootKey(rootKeyValue)
                  if (
                    !normalizedUrl ||
                    !deviceIdFromToken(normalizedToken) ||
                    !normalizedRootKey
                  ) return false
                  const normalizedServiceUrl = normalizedUrl.replace(/\/$/, '')
                  const urlResult = writeStorageValue(JOURNAL_API_URL_KEY, normalizedServiceUrl)
                  const tokenResult = writeStorageValue(JOURNAL_API_TOKEN_KEY, normalizedToken)
                  const rootKeyResult = writeStorageValue(
                    JOURNAL_ROOT_KEY_STORAGE_KEY,
                    serializeRootKey(normalizedRootKey),
                  )
                  if (!urlResult.ok) {
                    setStorageIssue(urlResult.issue)
                    return false
                  }
                  if (!tokenResult.ok) {
                    setStorageIssue(tokenResult.issue)
                    return false
                  }
                  if (!rootKeyResult.ok) {
                    setStorageIssue(rootKeyResult.issue)
                    return false
                  }
                  setJournalApiUrl(normalizedServiceUrl)
                  setJournalApiToken(normalizedToken)
                  setJournalRootKey(normalizedRootKey)
                  syncConfigEpochRef.current += 1
                  setSyncState('syncing')
                  return true
                }}
                onChatGptUrl={(value) => {
                  setChatGptUrl(value)
                  const result = writeStorageValue(
                    SETTINGS_KEY,
                    JSON.stringify({ chatGptUrl: value }),
                  )
                  if (!result.ok) setStorageIssue(result.issue)
                }}
                entries={sortedEntries}
                storageIssue={storageIssue}
              />
            )}
          </div>
        </main>

        <nav className="mobile-nav">
            {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => navigate(id)}
              aria-current={view === id ? 'page' : undefined}
            >
              <span className="nav-icon-frame" aria-hidden="true">
                <Icon />
              </span>
              <span>{label}</span>
            </button>
          ))}
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => navigate("settings")}
            aria-current={view === 'settings' ? 'page' : undefined}
          >
            <span className="nav-icon-frame" aria-hidden="true">
              <SlidersHorizontal />
            </span>
            <span>设置</span>
          </button>
        </nav>
      </div>
    </>
  );
}

export default App;
