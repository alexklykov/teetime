import { z } from 'zod'

export const COURSE_TIME_ZONE = 'America/Los_Angeles'
export const STALE_AFTER_MINUTES = 90

const dateValue = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T12:00:00Z`)
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    )
  })
const timeValue = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const searchSchema = z.object({
  date: dateValue.optional(),
  courses: z
    .string()
    .max(1000)
    .regex(/^[a-z0-9,-]*$/)
    .optional(),
  from: timeValue.optional(),
  to: timeValue.optional(),
  holes: z.enum(['9', '18']).optional(),
})
export type TeeTimeSearch = z.infer<typeof searchSchema>

export function pacificClock(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: COURSE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)!.value
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  }
}

export function addDays(date: string, days: number) {
  const result = new Date(`${date}T12:00:00Z`)
  result.setUTCDate(result.getUTCDate() + days)
  return result.toISOString().slice(0, 10)
}

export function selectedCourses(filter: string | undefined, slugs: string[]) {
  return filter === undefined
    ? slugs
    : slugs.filter((slug) => filter.split(',').includes(slug))
}

export function slotIsVisible(
  row: { time: string; holes: number; availableSpots: number | null },
  date: string,
  now: { date: string; time: string },
  filters: Pick<TeeTimeSearch, 'from' | 'to' | 'holes'>,
) {
  return (
    (date > now.date || (date === now.date && row.time > now.time)) &&
    (row.availableSpots == null || row.availableSpots > 0) &&
    (!filters.from || row.time >= filters.from) &&
    (!filters.to || row.time <= filters.to) &&
    (!filters.holes || row.holes === Number(filters.holes))
  )
}

export function slotKey(row: { time: string; holes: number }) {
  return `${row.time}|${row.holes}`
}

export type ScrapeStatus = {
  attemptedAt: string
  succeededAt: string | null
  failed: boolean
}

function ageLabel(at: string, now: Date) {
  const minutes = Math.max(
    0,
    Math.floor((now.getTime() - new Date(at).getTime()) / 60_000),
  )
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`
  return `${Math.floor(minutes / 1440)} day${minutes >= 2880 ? 's' : ''} ago`
}

export function freshness(status: ScrapeStatus | null, now: Date) {
  if (!status) return { state: 'unknown', label: 'Not checked yet' }
  if (status.failed)
    return {
      state: 'failed',
      label: `Refresh failed ${ageLabel(status.attemptedAt, now)}${status.succeededAt ? ` · last success ${ageLabel(status.succeededAt, now)}` : ''}`,
    }
  if (!status.succeededAt)
    return { state: 'unknown', label: 'No successful check yet' }
  const stale =
    now.getTime() - new Date(status.succeededAt).getTime() >
    STALE_AFTER_MINUTES * 60_000
  return {
    state: stale ? 'stale' : 'fresh',
    label: `${stale ? 'Out of date · checked' : 'Checked'} ${ageLabel(status.succeededAt, now)}`,
  }
}
