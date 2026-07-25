import { useEffect, useState } from 'react'
import { format } from 'date-fns'

function currentTodayKey(): string {
  return format(new Date(), 'yyyy-MM-dd')
}

function millisecondsUntilTomorrow(): number {
  const now = new Date()
  const tomorrow = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  )
  return Math.max(1_000, tomorrow.getTime() - now.getTime() + 100)
}

export function useTodayKey(): string {
  const [todayKey, setTodayKey] = useState(currentTodayKey)

  useEffect(() => {
    let timer: number | undefined
    const refresh = () => {
      setTodayKey(currentTodayKey())
      window.clearTimeout(timer)
      timer = window.setTimeout(refresh, millisecondsUntilTomorrow())
    }
    const resume = () => {
      if (document.visibilityState === 'visible') refresh()
    }

    refresh()
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [])

  return todayKey
}
