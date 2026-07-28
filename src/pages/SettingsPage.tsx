import { useEffect, useRef, useState } from 'react'
import { Archive, Bot, Check, Download, FileText, KeyRound, Save } from 'lucide-react'
import { format } from 'date-fns'
import type { JournalEntry } from '../journal/model.ts'
import type { StorageIssue } from '../journal/storage.ts'
import type { SyncState } from '../journal/status.ts'

type SettingsPageProps = {
  chatGptUrl: string
  defaultChatGptUrl: string
  journalApiUrl: string
  journalApiToken: string
  journalRootKey: string
  syncState: SyncState
  onCheckConnection: () => Promise<boolean>
  onChatGptUrl: (value: string) => void
  onSyncConfig: (url: string, token: string, rootKey: string) => boolean
  entries: JournalEntry[]
  storageIssue: StorageIssue | null
}

export function SettingsPage({
  chatGptUrl,
  defaultChatGptUrl,
  journalApiUrl,
  journalApiToken,
  journalRootKey,
  syncState,
  onCheckConnection,
  onChatGptUrl,
  onSyncConfig,
  entries,
  storageIssue,
}: SettingsPageProps) {
  const [exported, setExported] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [serviceUrl, setServiceUrl] = useState(journalApiUrl)
  const [serviceToken, setServiceToken] = useState(journalApiToken)
  const [serviceRootKey, setServiceRootKey] = useState(journalRootKey)
  const [syncConfigSaved, setSyncConfigSaved] = useState(false)
  const exportTimer = useRef<number | undefined>(undefined)
  const totalWords = entries.reduce(
    (sum, entry) => sum + entry.content.replace(/\s/g, '').length,
    0,
  )

  useEffect(() => {
    return () => window.clearTimeout(exportTimer.current)
  }, [])

  useEffect(() => {
    setServiceRootKey(journalRootKey)
  }, [journalRootKey])

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

  function saveSyncConfig() {
    const saved = onSyncConfig(serviceUrl, serviceToken, serviceRootKey)
    setSyncConfigSaved(saved)
    if (saved) setCheckedAt(null)
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
          <div className="settings-icon">
            <KeyRound />
          </div>
          <div>
            <div className="settings-title-row">
              <h3>同步服务配对</h3>
              <button
                className="connection-check"
                onClick={saveSyncConfig}
                disabled={
                  !/^https?:\/\//i.test(serviceUrl) ||
                  !/^dj1\.[A-Za-z0-9][A-Za-z0-9_-]{2,127}\.[A-Za-z0-9_-]{32,}$/.test(serviceToken.trim()) ||
                  !/^jk1\.[1-9][0-9]*\.[A-Za-z0-9_-]{43}$/.test(serviceRootKey.trim())
                }
              >
                {syncConfigSaved ? <Check /> : <Save />}
                {syncConfigSaved ? '已保存' : '保存'}
              </button>
            </div>
            <p>配置 Journal V2 服务、独立设备令牌和端到端加密密钥。</p>
            <div className="settings-fields">
              <input
                type="url"
                value={serviceUrl}
                onChange={(event) => {
                  setServiceUrl(event.target.value)
                  setSyncConfigSaved(false)
                }}
                placeholder="https://journal-sync.example.com"
                aria-label="Journal 同步服务地址"
              />
              <input
                type="password"
                value={serviceToken}
                onChange={(event) => {
                  setServiceToken(event.target.value)
                  setSyncConfigSaved(false)
                }}
                autoComplete="off"
                placeholder="配对令牌"
                aria-label="Journal 同步服务配对令牌"
              />
              <input
                type="password"
                value={serviceRootKey}
                onChange={(event) => {
                  setServiceRootKey(event.target.value)
                  setSyncConfigSaved(false)
                }}
                autoComplete="off"
                placeholder="jk1.1.…"
                aria-label="Journal 端到端加密密钥"
              />
            </div>
            <small>新设备首次恢复前必须安全传入同一把 jk1 密钥；密钥只保存在本机，不发送到服务端。</small>
          </div>
        </section>
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
