/** All time fields in the API are raw seconds (build_remaining_time, cooldown_s, ...) — this is the one place that turns them into "1d 2h 3m" for display. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return "-"

  const sign = totalSeconds < 0 ? "-" : ""
  let remaining = Math.round(Math.abs(totalSeconds))

  const weeks = Math.floor(remaining / 604800)
  remaining -= weeks * 604800
  const days = Math.floor(remaining / 86400)
  remaining -= days * 86400
  const hours = Math.floor(remaining / 3600)
  remaining -= hours * 3600
  const minutes = Math.floor(remaining / 60)
  const seconds = remaining - minutes * 60

  const parts: string[] = []
  if (weeks) parts.push(`${weeks}w`)
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (minutes) parts.push(`${minutes}m`)
  if (seconds || parts.length === 0) parts.push(`${seconds}s`)

  return sign + parts.join(" ")
}

/** Heuristic: the catalog never tags units explicitly, so this looks at the name/description instead. */
export function isSecondsField(name: string, description: string): boolean {
  return name.endsWith("_s") || name.endsWith("_time") || description.toLowerCase().includes("second")
}
