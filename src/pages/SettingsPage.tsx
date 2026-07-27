import { useEffect, useRef, useState } from 'react'
import {
  Archive,
  Bot,
  Check,
  Download,
  FileText,
  KeyRound,
  LockKeyhole,
  Radar,
  Save,
  Type,
} from 'lucide-react'
import { format } from 'date-fns'
import type { JournalEntry } from '../journal/model.ts'
import type { StorageIssue } from '../journal/storage.ts'
import type { SyncState } from '../journal/status.ts'
import { journalFetch } from '../journal/http.ts'
import {
  canDiscoverJournalService,
  discoverJournalService,
} from '../native/journalDiscovery.ts'

type LockSectionProps = {
  lockEnabled: boolean
  onEnableLock: (
    pin: string,
  ) => Promise<'ok' | 'invalid' | 'unsupported' | 'storage'>
  onDisableLock: (pin: string) => Promise<boolean>
  onChangeLock: (
    currentPin: string,
    nextPin: string,
  ) => Promise<'ok' | 'wrong' | 'invalid' | 'unsupported' | 'storage'>
}

/** 应用锁设置：开启、修改、关闭都在这一块完成，反馈就地显示。 */
function LockSection({
  lockEnabled,
  onEnableLock,
  onDisableLock,
  onChangeLock,
}: LockSectionProps) {
  const [pinA, setPinA] = useState('')
  const [pinB, setPinB] = useState('')
  const [currentPin, setCurrentPin] = useState('')
  const [nextPin, setNextPin] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  function report(result: 'ok' | 'invalid' | 'unsupported' | 'storage' | 'wrong', okText: string) {
    setMessage(
      result === 'ok'
        ? okText
        : result === 'invalid'
          ? '密码需要是 4–6 位数字。'
          : result === 'wrong'
            ? '当前密码不正确。'
            : result === 'unsupported'
              ? '当前环境不支持安全加密，无法开启应用锁。'
              : '本地存储写入失败，请检查存储空间。',
    )
  }

  async function enable() {
    if (busy) return
    if (pinA !== pinB) {
      setMessage('两次输入的密码不一致。')
      return
    }
    setBusy(true)
    const result = await onEnableLock(pinA)
    setBusy(false)
    report(result, '应用锁已开启，下次打开需要输入密码。')
    if (result === 'ok') {
      setPinA('')
      setPinB('')
    }
  }

  async function change() {
    if (busy) return
    setBusy(true)
    const result = await onChangeLock(currentPin, nextPin)
    setBusy(false)
    report(result, '密码已更新。')
    if (result === 'ok') {
      setCurrentPin('')
      setNextPin('')
    }
  }

  async function disable() {
    if (busy) return
    setBusy(true)
    const ok = await onDisableLock(currentPin)
    setBusy(false)
    setMessage(ok ? '应用锁已关闭。' : '当前密码不正确。')
    if (ok) setCurrentPin('')
  }

  return (
    <section>
      <div className="settings-icon">
        <LockKeyhole />
      </div>
      <div>
        <div className="settings-title-row">
          <h3>应用锁</h3>
          <span className={`connection-pill ${lockEnabled ? 'synced' : ''}`}>
            <i />
            {lockEnabled ? '已开启' : '未开启'}
          </span>
        </div>
        {lockEnabled ? (
          <>
            <p>
              修改或关闭需要验证当前密码。密码只保存在本机，忘记密码只能清除
              应用数据；已同步的日记仍保存在同步服务中。
            </p>
            <div className="settings-fields">
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={currentPin}
                onChange={(event) => {
                  setCurrentPin(event.target.value.replace(/\D/g, ''))
                  setMessage('')
                }}
                placeholder="当前密码"
                aria-label="当前应用锁密码"
              />
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={nextPin}
                onChange={(event) => {
                  setNextPin(event.target.value.replace(/\D/g, ''))
                  setMessage('')
                }}
                placeholder="新密码（修改时填写）"
                aria-label="新的应用锁密码"
              />
            </div>
            <div className="settings-actions-row">
              <button
                className="secondary-button"
                onClick={() => void change()}
                disabled={busy || !currentPin || !nextPin}
              >
                修改密码
              </button>
              <button
                className="secondary-button is-danger"
                onClick={() => void disable()}
                disabled={busy || !currentPin}
              >
                关闭应用锁
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              开启后，每次打开拾光需要输入 4–6 位数字密码，防止别人随手翻看。
              这是一道进入门，日记数据本身仍以本地明文保存并参与同步。
            </p>
            <div className="settings-fields">
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pinA}
                onChange={(event) => {
                  setPinA(event.target.value.replace(/\D/g, ''))
                  setMessage('')
                }}
                placeholder="设置 4–6 位数字密码"
                aria-label="设置应用锁密码"
              />
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pinB}
                onChange={(event) => {
                  setPinB(event.target.value.replace(/\D/g, ''))
                  setMessage('')
                }}
                placeholder="再输入一次"
                aria-label="确认应用锁密码"
              />
            </div>
            <button
              className="secondary-button"
              onClick={() => void enable()}
              disabled={busy || pinA.length < 4 || pinB.length < 4}
            >
              开启应用锁
            </button>
          </>
        )}
        {message && <small role="status">{message}</small>}
      </div>
    </section>
  )
}

type SettingsPageProps = LockSectionProps & {
  writeFont: 'serif' | 'sans'
  onWriteFont: (value: 'serif' | 'sans') => void
  chatGptUrl: string
  defaultChatGptUrl: string
  journalApiUrl: string
  journalApiToken: string
  syncState: SyncState
  onCheckConnection: () => Promise<boolean>
  onChatGptUrl: (value: string) => void
  onSyncConfig: (url: string, token: string) => boolean
  entries: JournalEntry[]
  storageIssue: StorageIssue | null
}

export function SettingsPage({
  writeFont,
  onWriteFont,
  lockEnabled,
  onEnableLock,
  onDisableLock,
  onChangeLock,
  chatGptUrl,
  defaultChatGptUrl,
  journalApiUrl,
  journalApiToken,
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
  const [pairingCode, setPairingCode] = useState('')
  const [syncConfigSaved, setSyncConfigSaved] = useState(Boolean(journalApiToken))
  const [discovering, setDiscovering] = useState(false)
  const [pairing, setPairing] = useState(false)
  const [discoveryMessage, setDiscoveryMessage] = useState('')
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

  async function discoverService() {
    if (discovering) return
    setDiscovering(true)
    setDiscoveryMessage('')
    try {
      const service = await discoverJournalService()
      setServiceUrl(service.url)
      setSyncConfigSaved(false)
      setDiscoveryMessage(`已发现 ${service.name}`)
    } catch (error) {
      setDiscoveryMessage(
        error instanceof Error ? error.message : '未发现同步服务',
      )
    } finally {
      setDiscovering(false)
    }
  }

  async function pairService() {
    if (pairing || !/^\d{6}$/.test(pairingCode)) return
    setPairing(true)
    setDiscoveryMessage('')
    try {
      const baseUrl = serviceUrl.replace(/\/$/, '')
      const response = await journalFetch(`${baseUrl}/pairing/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: pairingCode }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        const errorCode = body?.error?.code
        throw new Error(
          errorCode === 'PAIRING_CODE_REJECTED'
            ? '配对码不正确，请检查后重试。'
            : errorCode === 'PAIRING_LOCKED'
              ? '尝试次数已用完，请在电脑上生成新配对码。'
              : errorCode === 'PAIRING_EXPIRED' || errorCode === 'PAIRING_NOT_ACTIVE'
                ? '配对码已失效，请在电脑上生成新配对码。'
                : '配对服务暂时不可用。',
        )
      }
      if (typeof body.token !== 'string' || body.token.length < 32) {
        throw new Error('配对服务返回了无效凭据。')
      }
      const saved = onSyncConfig(baseUrl, body.token)
      if (!saved) throw new Error('配对凭据无法保存到本机。')
      setPairingCode('')
      setSyncConfigSaved(true)
      setCheckedAt(null)
      setDiscoveryMessage('配对成功，正在同步。')
    } catch (error) {
      setDiscoveryMessage(error instanceof Error ? error.message : '配对失败。')
    } finally {
      setPairing(false)
    }
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
              <div className="connection-actions">
                {canDiscoverJournalService() && (
                  <button
                    className="connection-check"
                    onClick={() => void discoverService()}
                    disabled={discovering}
                  >
                    <Radar />
                    {discovering ? '发现中…' : '发现电脑'}
                  </button>
                )}
                <button
                  className="connection-check"
                  onClick={() => void pairService()}
                  disabled={
                    pairing ||
                    !/^https?:\/\//i.test(serviceUrl) ||
                    !/^\d{6}$/.test(pairingCode)
                  }
                >
                  {syncConfigSaved ? <Check /> : <Save />}
                  {pairing ? '配对中…' : syncConfigSaved ? '已配对' : '配对'}
                </button>
              </div>
            </div>
            <p>在电脑开始菜单打开“拾光手机配对”，输入窗口中的 6 位配对码。</p>
            <div className="settings-fields">
              <input
                type="url"
                value={serviceUrl}
                onChange={(event) => {
                  setServiceUrl(event.target.value)
                  setSyncConfigSaved(false)
                }}
                placeholder="http://journal-host.local:8780"
                aria-label="Journal 同步服务地址"
              />
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={pairingCode}
                onChange={(event) => {
                  setPairingCode(event.target.value.replace(/\D/g, ''))
                  setSyncConfigSaved(false)
                }}
                autoComplete="off"
                placeholder={journalApiToken ? '已安全配对' : '电脑上显示的 6 位配对码'}
                aria-label="Journal 同步服务 6 位配对码"
              />
            </div>
            {discoveryMessage && <small role="status">{discoveryMessage}</small>}
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
            <Type />
          </div>
          <div>
            <h3>书写字体</h3>
            <p>
              正文即书：默认用衬线体书写与回看，中文衬线已随应用打包，
              手机上同样生效。
            </p>
            <div className="font-choice-row" role="radiogroup" aria-label="书写字体">
              <button
                className={`font-choice is-serif ${writeFont === 'serif' ? 'active' : ''}`}
                role="radio"
                aria-checked={writeFont === 'serif'}
                onClick={() => onWriteFont('serif')}
              >
                <strong>今日，拾光。</strong>
                <small>衬线 · 像一本书</small>
              </button>
              <button
                className={`font-choice is-sans ${writeFont === 'sans' ? 'active' : ''}`}
                role="radio"
                aria-checked={writeFont === 'sans'}
                onClick={() => onWriteFont('sans')}
              >
                <strong>今日，拾光。</strong>
                <small>黑体 · 像一张便签</small>
              </button>
            </div>
          </div>
        </section>
        <LockSection
          lockEnabled={lockEnabled}
          onEnableLock={onEnableLock}
          onDisableLock={onDisableLock}
          onChangeLock={onChangeLock}
        />
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
