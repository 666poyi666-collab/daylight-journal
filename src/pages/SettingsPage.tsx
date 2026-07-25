import { useEffect, useRef, useState } from 'react'
import { Archive, Bot, Check, Download, FileText } from 'lucide-react'
import { format } from 'date-fns'
import type { JournalEntry } from '../journal/model.ts'
import type { StorageIssue } from '../journal/storage.ts'
import type { SyncState } from '../journal/status.ts'

type SettingsPageProps = {
  chatGptUrl: string
  defaultChatGptUrl: string
  syncState: SyncState
  onCheckConnection: () => Promise<boolean>
  onChatGptUrl: (value: string) => void
  entries: JournalEntry[]
  storageIssue: StorageIssue | null
}

export function SettingsPage({
  chatGptUrl,
  defaultChatGptUrl,
  syncState,
  onCheckConnection,
  onChatGptUrl,
  entries,
  storageIssue,
}: SettingsPageProps) {
  const [exported, setExported] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const exportTimer = useRef<number | undefined>(undefined)
  const totalWords = entries.reduce(
    (sum, entry) => sum + entry.content.replace(/\s/g, '').length,
    0,
  )

  useEffect(() => {
    return () => window.clearTimeout(exportTimer.current)
  }, [])

  async function checkConnection() {
    setChecking(true)
    await onCheckConnection()
    setCheckedAt(new Date())
    setChecking(false)
  }

  function exportData() {
    const markdown = entries
      .map(
        (entry) =>
          `---\ntype: journal\ndate: ${entry.date}\nmood: ${entry.mood ?? ''}\ntags: ${JSON.stringify(entry.tags)}\n---\n\n# ${entry.title || entry.date}\n\n${entry.content}`,
      )
      .join('\n\n---\n\n')
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `拾光日记-${format(new Date(), 'yyyy-MM-dd')}.md`
    link.click()
    URL.revokeObjectURL(link.href)
    setExported(true)
    window.clearTimeout(exportTimer.current)
    exportTimer.current = window.setTimeout(() => setExported(false), 2200)
  }

  return (
    <div className="page-container settings-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">保持简单</span>
          <h1>设置</h1>
          <p>配置你的 ChatGPT 入口和数据导出方式。</p>
        </div>
      </div>
      <section className="settings-signal" aria-label="系统状态概览">
        <div className="signal-beacon">
          <span />
        </div>
        <div>
          <small>当前工作区</small>
          <strong>
            {storageIssue
              ? '本地存储需要检查'
              : syncState === 'synced'
                ? '同步服务可用'
                : syncState === 'offline'
                  ? '离线，仍可继续写作'
                  : '正在准备连接'}
          </strong>
        </div>
        <div className="signal-divider" />
        <div className="signal-detail">
          <small>本地记录</small>
          <strong>{entries.length} 篇</strong>
        </div>
        <div className="signal-detail">
          <small>最近检测</small>
          <strong>{checkedAt ? format(checkedAt, 'HH:mm') : '尚未检测'}</strong>
        </div>
      </section>
      <div className="settings-grid">
        <section>
          <div className="settings-icon ai">
            <Bot />
          </div>
          <div>
            <div className="settings-title-row">
              <h3>ChatGPT 日记项目</h3>
              <div className="connection-actions">
                <span className={`connection-pill ${syncState}`}>
                  <i />
                  {storageIssue
                    ? '本地存储异常'
                    : syncState === 'synced'
                      ? '同步服务可用'
                      : syncState === 'offline'
                        ? '仅本地可用'
                        : '正在连接'}
                </span>
                <button
                  className="connection-check"
                  onClick={() => void checkConnection()}
                  disabled={checking}
                >
                  {checking ? '检测中…' : '重新检测'}
                </button>
              </div>
            </div>
            <p>
              点击“让 ChatGPT 复盘”时，固定进入这个项目；复盘提示词会自动复制。
            </p>
            <input
              type="url"
              value={chatGptUrl}
              onChange={(event) => onChatGptUrl(event.target.value)}
              placeholder={defaultChatGptUrl}
              aria-label="ChatGPT 日记项目地址"
            />
            <small>默认已经配置为你的“日记”项目。</small>
          </div>
        </section>
        <section>
          <div className="settings-icon">
            <Download />
          </div>
          <div>
            <div className="settings-title-row">
              <h3>导出 Markdown</h3>
              <span className="integration-badge">OBSIDIAN READY</span>
            </div>
            <p>将全部日记导出为标准 Markdown，可用于 Obsidian 或本地备份。</p>
            <button
              className={`secondary-button ${exported ? 'is-done' : ''}`}
              onClick={exportData}
            >
              {exported ? (
                <>
                  <Check />
                  已导出
                </>
              ) : (
                <>
                  <FileText />
                  导出 {entries.length} 篇日记
                </>
              )}
            </button>
          </div>
        </section>
        <section>
          <div className="settings-icon">
            <Archive />
          </div>
          <div>
            <h3>本地存储</h3>
            <p>
              {storageIssue
                ? '当前浏览器无法可靠写入，请先导出数据并检查存储空间。'
                : '当前版本的数据保存在此浏览器中，无需登录即可使用。'}
            </p>
            <div className="storage-stat">
              <span>日记数量</span>
              <strong>{entries.length}</strong>
            </div>
            <div className="storage-stat">
              <span>累计字数</span>
              <strong>{totalWords.toLocaleString()}</strong>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
