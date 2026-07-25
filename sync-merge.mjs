function entryTimestamp(entry) {
  const timestamp = Date.parse(entry?.updatedAt || entry?.createdAt || '')
  return Number.isFinite(timestamp) ? timestamp : 0
}

/** Merge incoming entries without allowing an older revision to replace a newer one. */
export function mergeIncomingEntries(existing, incoming) {
  const merged = { ...existing }
  for (const entry of incoming) {
    if (!entry?.date) continue
    const current = merged[entry.date]
    if (!current || entryTimestamp(entry) >= entryTimestamp(current)) {
      merged[entry.date] = entry
    }
  }
  return merged
}
