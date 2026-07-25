import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import { hasEntryContent, type JournalEntries } from '../journal/model.ts'
import { journalMoods } from '../journal/moods.ts'

type CalendarPageProps = {
  month: Date
  entries: JournalEntries
  selectedDate: string
  onPrevious: () => void
  onNext: () => void
  onToday: () => void
  onOpen: (date: string) => void
}

export function CalendarPage({
  month,
  entries,
  selectedDate,
  onPrevious,
  onNext,
  onToday,
  onOpen,
}: CalendarPageProps) {
  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }),
  })
  const monthEntries = Object.values(entries).filter((entry) => {
    const date = parseISO(entry.date)
    return isSameMonth(date, month) && hasEntryContent(entry)
  })
  const moodEntries = monthEntries.filter((entry) => entry.mood)
  const averageMood = moodEntries.length
    ? Math.round(
        (moodEntries.reduce((sum, entry) => sum + (entry.mood || 0), 0) /
          moodEntries.length) *
          10,
      ) / 10
    : null

  return (
    <div className="page-container calendar-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">你的时间</span>
          <h1>{format(month, 'yyyy年 M月')}</h1>
          <p>有些日子值得被写下来，也值得重新打开。</p>
          <div className="calendar-stats" aria-label="本月记录概览">
            <span>
              <strong>{monthEntries.length}</strong> 篇记录
            </span>
            <span>
              <strong>{averageMood ?? '—'}</strong> 平均心情
            </span>
          </div>
        </div>
        <div className="month-actions">
          <button onClick={onPrevious} aria-label="上个月">
            <ChevronLeft />
          </button>
          <button onClick={onToday}>今天</button>
          <button onClick={onNext} aria-label="下个月">
            <ChevronRight />
          </button>
        </div>
      </div>
      <section className="calendar-card">
        <div className="weekday-row">
          {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <div className="calendar-grid">
          {days.map((day) => {
            const key = format(day, 'yyyy-MM-dd')
            const hasEntry = hasEntryContent(entries[key])
            const moodLevel = entries[key]?.mood
            const moodLabel = journalMoods.find(
              (mood) => mood.value === moodLevel,
            )?.label
            return (
              <button
                key={key}
                onClick={() => onOpen(key)}
                aria-label={`${format(day, 'yyyy年M月d日')}，${hasEntry ? '已记录' : '未记录'}${moodLabel ? `，心情${moodLabel}` : ''}`}
                title={
                  hasEntry
                    ? `${format(day, 'M月d日')} · ${entries[key].title || '无题日记'}`
                    : `${format(day, 'M月d日')} · 写一页`
                }
                className={`${!isSameMonth(day, month) ? 'muted' : ''} ${isSameDay(day, new Date()) ? 'today' : ''} ${key === selectedDate ? 'selected' : ''} ${hasEntry ? 'has-entry' : ''} ${moodLevel ? `mood-${moodLevel}` : ''}`}
                aria-current={key === selectedDate ? 'date' : undefined}
              >
                <strong>{format(day, 'd')}</strong>
                {hasEntry && (
                  <>
                    <span>
                      {entries[key].title || entries[key].content.slice(0, 16)}
                    </span>
                    <i />
                  </>
                )}
              </button>
            )
          })}
        </div>
      </section>
      <div className="calendar-legend" aria-label="心情色阶图例">
        <span className="legend-label">心情色阶</span>
        {journalMoods.map((mood) => (
          <span key={mood.value} className="legend-item">
            <i className={`mood-${mood.value}`} />
            {mood.label}
          </span>
        ))}
      </div>
    </div>
  )
}
