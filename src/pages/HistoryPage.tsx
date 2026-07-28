import { useState } from 'react'
import { Archive, Plus, Search, X } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { journalPreviewText, type JournalEntry } from '../journal/model.ts'
import { journalMoods } from '../journal/moods.ts'

type HistoryPageProps = {
  entries: JournalEntry[]
  search: string
  onSearch: (value: string) => void
  onOpen: (date: string) => void
  onWrite: () => void
}

export function HistoryPage({
  entries,
  search,
  onSearch,
  onOpen,
  onWrite,
}: HistoryPageProps) {
  const [moodFilter, setMoodFilter] = useState<number | null>(null)
  const filtered = entries
    .filter((entry) =>
      `${entry.title} ${entry.content} ${entry.tags.join(' ')}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .filter((entry) => moodFilter === null || entry.mood === moodFilter)
  const totalWords = entries.reduce(
    (sum, entry) => sum + entry.content.replace(/\s/g, '').length,
    0,
  )
  const latestEntry = entries[0]
  const groupedEntries = Array.from(
    filtered.reduce<Map<string, JournalEntry[]>>((groups, entry) => {
      const key = format(parseISO(entry.date), 'yyyy年 M月')
      const group = groups.get(key) || []
      group.push(entry)
      groups.set(key, group)
      return groups
    }, new Map()),
  )

  return (
    <div className="page-container history-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">一路走来</span>
          <h1>历史记录</h1>
          <p>
            {entries.length
              ? `你已经留下了 ${entries.length} 篇记录。`
              : '你的第一篇日记，会从这里开始。'}
          </p>
          {entries.length > 0 && (
            <div className="history-stats" aria-label="日记总览">
              <span>
                <strong>{totalWords.toLocaleString()}</strong> 字
              </span>
              <span>
                <strong>
                  {latestEntry
                    ? format(parseISO(latestEntry.date), 'M月d日')
                    : '—'}
                </strong>{' '}
                最近记录
              </span>
            </div>
          )}
        </div>
        <div className={`search-box ${search ? 'has-value' : ''}`} role="search">
          <Search />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="搜索日记、内容或标签"
            aria-label="搜索日记、内容或标签"
          />
          {search && (
            <button
              className="search-clear"
              onClick={() => onSearch('')}
              aria-label="清除搜索"
              title="清除搜索"
            >
              <X />
            </button>
          )}
        </div>
      </div>
      {(search || moodFilter !== null) && (
        <div className="search-summary" role="status">
          <span>
            {search
              ? `找到 ${filtered.length} 篇相关记录`
              : `筛选出 ${filtered.length} 篇记录`}
          </span>
          <button
            onClick={() => {
              onSearch('')
              setMoodFilter(null)
            }}
          >
            清除筛选 <X />
          </button>
        </div>
      )}
      <div className="mood-filter" role="group" aria-label="按心情筛选">
        <span>心情</span>
        <button
          className={moodFilter === null ? 'active' : ''}
          onClick={() => setMoodFilter(null)}
          aria-pressed={moodFilter === null}
        >
          全部
        </button>
        {journalMoods.map((mood) => (
          <button
            key={mood.value}
            className={moodFilter === mood.value ? 'active' : ''}
            onClick={() => setMoodFilter(mood.value)}
            aria-label={`筛选${mood.label}`}
            aria-pressed={moodFilter === mood.value}
          >
            {mood.emoji}
          </button>
        ))}
      </div>
      {filtered.length ? (
        <div className="history-grid history-timeline">
          {groupedEntries.map(([month, monthEntries]) => (
            <section className="history-month" key={month}>
              <header className="history-month-label">
                <strong>{month}</strong>
                <small>{monthEntries.length} 篇记录</small>
              </header>
              <div className="history-month-entries">
                {monthEntries.map((entry) => {
                  const mood = journalMoods.find(
                    (item) => item.value === entry.mood,
                  )
                  return (
                    <article
                      key={entry.date}
                      tabIndex={0}
                      role="button"
                      aria-label={`${entry.date}，${entry.title || '无题日记'}${mood ? `，心情${mood.label}` : ''}`}
                      onClick={() => onOpen(entry.date)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onOpen(entry.date)
                        }
                      }}
                    >
                      <span className="timeline-node" aria-hidden="true" />
                      <div className="history-date">
                        <strong>{format(parseISO(entry.date), 'dd')}</strong>
                        <span>
                          {format(parseISO(entry.date), 'EEE', {
                            locale: zhCN,
                          })}
                        </span>
                      </div>
                      {entry.coverImage && (
                        <img
                          className="history-cover"
                          src={entry.coverImage}
                          alt=""
                          loading="lazy"
                        />
                      )}
                      <div className="history-content">
                        <div>
                          <h3>{entry.title || '无题日记'}</h3>
                          {entry.mood && (
                            <span className={`history-mood mood-${entry.mood}`}>
                              {mood?.emoji}
                              <small>{mood?.label}</small>
                            </span>
                          )}
                        </div>
                        <p>
                          {journalPreviewText(entry.content) ||
                            '这一天只留下了一个标题。'}
                        </p>
                        <footer>
                          {entry.tags.map((tag) => (
                            <span key={tag}>#{tag}</span>
                          ))}
                          <small>
                            {entry.content.replace(/\s/g, '').length} 字 ·{' '}
                            {format(
                              parseISO(entry.updatedAt || entry.createdAt),
                              'HH:mm',
                            )}
                          </small>
                        </footer>
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Archive />
          <h2>
            {search || moodFilter !== null ? '没有找到相关日记' : '还没有日记'}
          </h2>
          <p>
            {search || moodFilter !== null
              ? '换一个关键词或心情试试看。'
              : '写下今天，时间就有了形状。'}
          </p>
          {search || moodFilter !== null ? (
            <button
              className="secondary-button empty-action"
              onClick={() => {
                onSearch('')
                setMoodFilter(null)
              }}
            >
              清除筛选
            </button>
          ) : (
            <button className="secondary-button empty-action" onClick={onWrite}>
              <Plus size={16} /> 写下今天
            </button>
          )}
        </div>
      )}
    </div>
  )
}
