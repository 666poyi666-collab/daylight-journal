import { useEffect, useRef, useState } from 'react'
import { Delete } from 'lucide-react'
import { verifyPin, type LockRecord } from '../journal/lock.ts'

const MAX_ATTEMPTS = 5
const COOLDOWN_MS = 30_000

const padKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

export function LockScreen({
  record,
  onUnlock,
}: {
  record: LockRecord
  onUnlock: () => void
}) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState(false)
  const [failCount, setFailCount] = useState(0)
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const checking = useRef(false)
  const resetTimer = useRef<number | undefined>(undefined)
  const cooldownActive = cooldownUntil > now
  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))

  useEffect(() => {
    if (!cooldownActive) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [cooldownActive])

  useEffect(() => {
    return () => window.clearTimeout(resetTimer.current)
  }, [])

  async function submit(candidate: string) {
    if (checking.current) return
    checking.current = true
    const ok = await verifyPin(record, candidate)
    checking.current = false
    if (ok) {
      onUnlock()
      return
    }
    setError(true)
    navigator.vibrate?.(60)
    const fails = failCount + 1
    if (fails >= MAX_ATTEMPTS) {
      setCooldownUntil(Date.now() + COOLDOWN_MS)
      setNow(Date.now())
      setFailCount(0)
    } else {
      setFailCount(fails)
    }
    window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => {
      setPin('')
      setError(false)
    }, 420)
  }

  function pushDigit(digit: string) {
    if (cooldownActive || error || checking.current) return
    setPin((current) => {
      const next = (current + digit).slice(0, record.length)
      if (next.length === record.length) void submit(next)
      return next
    })
  }

  function popDigit() {
    if (error) return
    setPin((current) => current.slice(0, -1))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (/^\d$/.test(event.key)) {
        event.preventDefault()
        pushDigit(event.key)
      } else if (event.key === 'Backspace') {
        event.preventDefault()
        popDigit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // pushDigit/popDigit 闭包依赖的 state 均通过函数式更新读取，监听器无需重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cooldownActive, error, record])

  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-label="应用锁">
      <span className="brand-mark" aria-hidden="true">
        <img src="/icon-journal-sunrise.png" alt="" />
      </span>
      <strong className="lock-title">拾光</strong>
      <p className="lock-hint" aria-live="polite">
        {cooldownActive
          ? `密码错误次数过多，${cooldownSeconds} 秒后再试`
          : error
            ? '密码不正确'
            : '输入密码，打开你的日记'}
      </p>
      <div
        className={`lock-dots ${error ? 'is-error' : ''}`}
        aria-label={`已输入 ${pin.length} / ${record.length} 位`}
      >
        {Array.from({ length: record.length }, (_, index) => (
          <i key={index} className={index < pin.length ? 'filled' : ''} />
        ))}
      </div>
      <div className="lock-pad" role="group" aria-label="数字键盘">
        {padKeys.map((digit) => (
          <button
            key={digit}
            onClick={() => pushDigit(digit)}
            disabled={cooldownActive}
          >
            {digit}
          </button>
        ))}
        <span className="lock-blank" aria-hidden="true" />
        <button onClick={() => pushDigit('0')} disabled={cooldownActive}>
          0
        </button>
        <button
          className="lock-delete"
          onClick={popDigit}
          aria-label="删除一位"
          disabled={cooldownActive}
        >
          <Delete />
        </button>
      </div>
      <details className="lock-forgot">
        <summary>忘记密码？</summary>
        <p>
          密码只保存在这台设备上，无法找回或绕过。清除应用数据（或浏览器站点数据）
          可以重新进入，本机日记会被清除；已同步的日记仍保存在你的同步服务中。
        </p>
      </details>
    </div>
  )
}
