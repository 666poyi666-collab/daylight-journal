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
  syncConfigured: boolean
  syncState: SyncState
  onCheckConnection: () => Promise<boolean>
  onChatGptUrl: (value: string) => void
  onSyncConfig: (url: string, token: string) => Promise<boolean>
  onCreateRecoveryPackage: (secret: string) => Promise<Record<string, unknown>>
  onImportRecoveryPackage: (secret: string, value: unknown) => Promise<void>
  onCreateApprovalIdentity: () => Promise<Record<string, unknown>>
  onCreateApprovalPackage: (target: unknown) => Promise<Record<string, unknown>>
  onAcceptApprovalPackage: (value: unknown) => Promise<void>
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
  syncConfigured,
  syncState,
  onCheckConnection,
  onChatGptUrl,
  onSyncConfig,
  onCreateRecoveryPackage,
  onImportRecoveryPackage,
  onCreateApprovalIdentity,
  onCreateApprovalPackage,
  onAcceptApprovalPackage,
  entries,
  storageIssue,
}: SettingsPageProps) {
  const [exported, setExported] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [serviceUrl, setServiceUrl] = useState(journalApiUrl)
  const [deviceToken, setDeviceToken] = useState('')
  const [syncConfigSaved, setSyncConfigSaved] = useState(syncConfigured)
  const [discovering, setDiscovering] = useState(false)
  const [savingCredential, setSavingCredential] = useState(false)
  const [discoveryMessage, setDiscoveryMessage] = useState('')
  const [recoverySecret, setRecoverySecret] = useState('')
  const [recoveryPackage, setRecoveryPackage] = useState('')
  const [approvalRequest, setApprovalRequest] = useState('')
  const [approvalPackage, setApprovalPackage] = useState('')
  const [keyMessage, setKeyMessage] = useState('')
  const exportTimer = useRef<number | undefined>(undefined)
  const totalWords = entries.reduce(
    (sum, entry) => sum + entry.content.replace(/\s/g, '').length,
    0,
  )

  useEffect(() => {
    return () => window.clearTimeout(exportTimer.current)
  }, [])

  useEffect(() => {
    setServiceUrl(journalApiUrl)
    setSyncConfigSaved(syncConfigured)
  }, [journalApiUrl, syncConfigured])

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

  async function saveDeviceCredential() {
    if (savingCredential) return
    setSavingCredential(true)
    setDiscoveryMessage('')
    try {
      const baseUrl = serviceUrl.replace(/\/$/, '')
      const saved = await onSyncConfig(baseUrl, deviceToken)
      if (!saved) throw new Error('配对凭据无法保存到本机。')
      setDeviceToken('')
      setSyncConfigSaved(true)
      setCheckedAt(null)
      setDiscoveryMessage('设备凭据已保存到安全存储。')
    } catch (error) {
      setDiscoveryMessage(error instanceof Error ? error.message : '设备凭据保存失败。')
    } finally {
      setSavingCredential(false)
    }
  }

  function parsePackage(value: string, label: string): unknown {
    try {
      return JSON.parse(value)
    } catch {
      throw new Error(`${label} 不是有效 JSON。`)
    }
  }

  async function exportRecoveryPackage() {
    try {
      const value = await onCreateRecoveryPackage(recoverySecret)
      setRecoveryPackage(JSON.stringify(value, null, 2))
      setKeyMessage('恢复包已生成。')
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : '恢复包生成失败。')
    }
  }

  async function importRecoveryPackage() {
    try {
      await onImportRecoveryPackage(recoverySecret, parsePackage(recoveryPackage, '恢复包'))
      setKeyMessage('恢复密钥已导入。')
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : '恢复包导入失败。')
    }
  }

  async function createApprovalRequest() {
    try {
      setApprovalRequest(JSON.stringify(await onCreateApprovalIdentity(), null, 2))
      setKeyMessage('设备批准请求已生成。')
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : '批准请求生成失败。')
    }
  }

  async function createApprovalPackage() {
    try {
      setApprovalPackage(JSON.stringify(
        await onCreateApprovalPackage(parsePackage(approvalRequest, '设备批准请求')),
        null,
        2,
      ))
      setKeyMessage('已生成设备批准包。')
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : '批准包生成失败。')
    }
  }

  async function acceptApprovalPackage() {
    try {
      await onAcceptApprovalPackage(parsePackage(approvalPackage, '设备批准包'))
      setKeyMessage('设备批准包已导入。')
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : '批准包导入失败。')
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
              <h3>加密同步设备</h3>
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
                  onClick={() => void saveDeviceCredential()}
                  disabled={
                    savingCredential ||
                    !/^https?:\/\//i.test(serviceUrl) ||
                    !/^dj1\.[A-Za-z0-9][A-Za-z0-9_-]{2,127}\.[A-Za-z0-9_-]{32,}$/.test(deviceToken)
                  }
                >
                  {syncConfigSaved ? <Check /> : <Save />}
                  {savingCredential ? '保存中…' : syncConfigSaved ? '已绑定' : '保存 token'}
                </button>
              </div>
            </div>
            <p>使用由授权设备或离线恢复流程签发的设备 token。</p>
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
                type="password"
                value={deviceToken}
                onChange={(event) => {
                  setDeviceToken(event.target.value.trim())
                  setSyncConfigSaved(false)
                }}
                autoComplete="off"
                placeholder={syncConfigured ? '已保存到安全存储' : 'dj1.<device-id>.<secret>'}
                aria-label="Journal 同步设备 token"
              />
            </div>
            {discoveryMessage && <small role="status">{discoveryMessage}</small>}
          </div>
        </section>
        <section>
          <div className="settings-icon">
            <KeyRound />
          </div>
          <div>
            <div className="settings-title-row">
              <h3>恢复与设备批准</h3>
            </div>
            <div className="settings-fields">
              <input
                type="password"
                value={recoverySecret}
                onChange={(event) => setRecoverySecret(event.target.value)}
                autoComplete="new-password"
                placeholder="恢复密钥短语（至少 16 个字符）"
                aria-label="Journal 恢复密钥短语"
              />
              <div className="connection-actions">
                <button className="connection-check" onClick={() => void exportRecoveryPackage()} disabled={!syncConfigured}>
                  导出恢复包
                </button>
                <button className="connection-check" onClick={() => void importRecoveryPackage()} disabled={!syncConfigured}>
                  导入恢复包
                </button>
              </div>
              <textarea
                value={recoveryPackage}
                onChange={(event) => setRecoveryPackage(event.target.value)}
                placeholder="恢复包 JSON"
                aria-label="Journal 恢复包"
              />
              <div className="connection-actions">
                <button className="connection-check" onClick={() => void createApprovalRequest()} disabled={!syncConfigured}>
                  生成批准请求
                </button>
                <button className="connection-check" onClick={() => void createApprovalPackage()} disabled={!syncConfigured || !approvalRequest.trim()}>
                  生成批准包
                </button>
                <button className="connection-check" onClick={() => void acceptApprovalPackage()} disabled={!syncConfigured || !approvalPackage.trim()}>
                  导入批准包
                </button>
              </div>
              <textarea
                value={approvalRequest}
                onChange={(event) => setApprovalRequest(event.target.value)}
                placeholder="设备批准请求 JSON"
                aria-label="Journal 设备批准请求"
              />
              <textarea
                value={approvalPackage}
                onChange={(event) => setApprovalPackage(event.target.value)}
                placeholder="设备批准包 JSON"
                aria-label="Journal 设备批准包"
              />
            </div>
            {keyMessage && <small role="status">{keyMessage}</small>}
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
