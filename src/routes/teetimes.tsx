import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { prisma } from '#/db'
import {
  addDays,
  freshness,
  pacificClock,
  searchSchema,
  selectedCourses,
  slotIsVisible,
  slotKey,
} from '#/lib/tee-times'

const getPageData = createServerFn({ method: 'GET' })
  .validator(searchSchema)
  .handler(async ({ data }) => {
    const now = new Date()
    const today = pacificClock(now).date
    const lastDate = addDays(today, 6)
    const date =
      data.date && data.date >= today && data.date <= lastDate
        ? data.date
        : today
    const courses = await prisma.course.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        slug: true,
        name: true,
        bookingUrl: true,
        scrapeStatuses: {
          where: { date },
          select: { attemptedAt: true, succeededAt: true, error: true },
        },
      },
    })
    const selected = selectedCourses(
      data.courses,
      courses.map((c) => c.slug),
    )
    const rawRows = await prisma.teeTime.findMany({
      where: {
        date,
        courseId: {
          in: courses.filter((c) => selected.includes(c.slug)).map((c) => c.id),
        },
      },
      orderBy: [{ time: 'asc' }, { holes: 'asc' }],
      select: {
        courseId: true,
        time: true,
        holes: true,
        price: true,
        price9: true,
        cartFee: true,
        rateName: true,
        availableSpots: true,
      },
    })
    return {
      courses: courses.map(({ scrapeStatuses, ...course }) => {
        const status = scrapeStatuses.at(0)
        return {
          ...course,
          status: status
            ? {
                attemptedAt: status.attemptedAt.toISOString(),
                succeededAt: status.succeededAt?.toISOString() ?? null,
                failed: status.error !== null,
              }
            : null,
        }
      }),
      date,
      today,
      loadedAt: now.toISOString(),
      rows: rawRows.map((row) => ({
        ...row,
        price: row.price == null ? null : Number(row.price),
        price9: row.price9 == null ? null : Number(row.price9),
        cartFee: row.cartFee == null ? null : Number(row.cartFee),
      })),
    }
  })

export const Route = createFileRoute('/teetimes')({
  component: TeeTimes,
  validateSearch: (input) => searchSchema.catch({}).parse(input),
  loaderDeps: ({ search }) => ({ date: search.date, courses: search.courses }),
  loader: ({ deps }) => getPageData({ data: deps }),
  pendingComponent: () => (
    <main className="page-wrap px-4 py-16" role="status">
      Loading tee times…
    </main>
  ),
  errorComponent: TeeTimesError,
})

function TeeTimesError() {
  const router = useRouter()
  return (
    <main className="page-wrap px-4 py-16">
      <h1 className="display-title text-3xl font-bold">
        Tee times are temporarily unavailable
      </h1>
      <p className="my-4 text-[var(--sea-ink-soft)]">
        We could not load the latest availability. Please try again shortly.
      </p>
      <button
        className="min-h-11 rounded-full bg-[var(--lagoon)] px-5 py-2 font-semibold text-[var(--surface)]"
        type="button"
        onClick={() => router.invalidate()}
      >
        Try again
      </button>
    </main>
  )
}

const money = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(value)
const fmtTime = (time: string) => {
  const [hour, minute] = time.split(':').map(Number)
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}
const displayDate = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    ...options,
    timeZone: 'UTC',
  })

type PageData = Awaited<ReturnType<typeof getPageData>>
type Slot = PageData['rows'][number]

function SlotLink({
  slot,
  bookingUrl,
  courseName,
  uncertain,
}: {
  slot: Slot
  bookingUrl: string
  courseName: string
  uncertain: boolean
}) {
  return (
    <a
      href={bookingUrl}
      target="_blank"
      rel="noreferrer"
      className="flex min-h-12 flex-col gap-1 rounded-xl bg-[color-mix(in_oklab,var(--lagoon)_10%,transparent)] px-3 py-2 text-[var(--lagoon)] no-underline transition hover:bg-[var(--lagoon)] hover:text-[var(--surface)] focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <span className="sr-only">
        {courseName}, {fmtTime(slot.time)}, {slot.holes} holes. Opens in a new
        tab.
      </span>
      <span className="font-bold">
        {slot.price == null ? 'See price' : `${money(slot.price)} / player`}
      </span>
      <span className="text-xs">
        {slot.availableSpots == null
          ? 'Check group availability'
          : `${slot.availableSpots} ${slot.availableSpots === 1 ? 'spot' : 'spots'} reported`}
      </span>
      {slot.rateName && <span className="text-xs">{slot.rateName}</span>}
      {slot.cartFee != null && (
        <span className="text-xs">
          Reported cart fee: {money(slot.cartFee)}
        </span>
      )}
      {slot.price9 != null && slot.holes !== 9 && (
        <span className="text-xs">
          9-hole rate also listed: {money(slot.price9)}
        </span>
      )}
      {uncertain && (
        <span className="text-xs font-semibold">
          Older listing · confirm on course site
        </span>
      )}
      <span className="text-xs underline underline-offset-2">
        Open course booking site ↗
      </span>
    </a>
  )
}

function TeeTimes() {
  const { courses, date, today, rows, loadedAt } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()
  const [now, setNow] = useState(() => new Date(loadedAt))
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)

  useEffect(() => {
    setNow(new Date())
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [loadedAt])

  const clock = pacificClock(now)
  useEffect(() => {
    if (clock.date !== today) void router.invalidate()
  }, [clock.date, today, router])

  const selected = selectedCourses(
    search.courses,
    courses.map((c) => c.slug),
  )
  const shownCourses = courses.filter((c) => selected.includes(c.slug))
  const visibleRows = rows.filter((row) =>
    slotIsVisible(row, date, clock, search),
  )
  const timeRows = [
    ...new Map(
      visibleRows.map((row) => [
        slotKey(row),
        { time: row.time, holes: row.holes },
      ]),
    ).values(),
  ]
  const cells = new Map(
    visibleRows.map((row) => [`${row.courseId}|${slotKey(row)}`, row]),
  )
  const courseFreshness = new Map(
    shownCourses.map((c) => [c.id, freshness(c.status, now)]),
  )
  const unconfirmed = shownCourses.some(
    (c) => courseFreshness.get(c.id)?.state !== 'fresh',
  )
  const invalidRange = Boolean(
    search.from && search.to && search.from > search.to,
  )
  const days = Array.from({ length: 7 }, (_, index) => addDays(today, index))

  const toggleCourse = (slug: string) => {
    void navigate({
      search: (previous) => {
        const current = selectedCourses(
          previous.courses,
          courses.map((c) => c.slug),
        )
        const next = current.includes(slug)
          ? current.filter((s) => s !== slug)
          : [...current, slug]
        return {
          ...previous,
          courses: next.length === courses.length ? undefined : next.join(','),
        }
      },
    })
  }
  const refresh = async () => {
    setRefreshing(true)
    setRefreshFailed(false)
    try {
      await router.invalidate()
    } catch {
      setRefreshFailed(true)
    } finally {
      setRefreshing(false)
    }
  }

  const emptyMessage =
    courses.length === 0
      ? 'Courses are not configured yet. Please check back soon.'
      : shownCourses.length === 0
        ? 'Choose at least one course to compare tee times.'
        : invalidRange
          ? 'The start time must be earlier than the end time.'
          : unconfirmed
            ? 'No confirmed openings for this selection. Some courses have not refreshed successfully; check their booking sites.'
            : 'No published openings match this selection. Try another date or time range.'

  return (
    <main className="page-wrap px-4 py-10">
      <p className="island-kicker mb-2">Tee Times</p>
      <h1 className="display-title mb-2 text-4xl font-bold text-[var(--sea-ink)]">
        Compare Tee Times
      </h1>
      <p className="mb-2 max-w-3xl text-sm text-[var(--sea-ink-soft)]">
        All times are Pacific. Prices are published rates per player; cart
        inclusion, fees, and eligibility can vary. Open a course’s booking site
        to choose your date and time and confirm the final price. Nothing is
        reserved here.
      </p>
      <div className="mb-6 flex flex-wrap items-center gap-3 text-xs text-[var(--sea-ink-soft)]">
        <span>Availability can change between checks.</span>
        <button
          type="button"
          disabled={refreshing}
          onClick={refresh}
          className="min-h-11 font-semibold text-[var(--lagoon)] underline underline-offset-4 disabled:opacity-50"
        >
          {refreshing ? 'Reloading…' : 'Reload saved listings'}
        </button>
        {refreshFailed && (
          <span role="alert">Refresh failed. Please try again.</span>
        )}
      </div>

      <section
        aria-label="Filter tee times"
        className="island-shell mb-6 flex flex-col gap-5 rounded-2xl p-4 sm:p-6"
      >
        <div className="flex flex-col gap-2 sm:max-w-lg">
          <div className="flex items-center justify-between gap-3">
            <span className="island-kicker">Date · Pacific</span>
            <span className="text-xs font-semibold text-[var(--sea-ink-soft)]">
              {displayDate(date, { month: 'long', year: 'numeric' })}
            </span>
          </div>
          <div className="grid grid-cols-7 gap-1">
            {days.map((day) => (
              <button
                key={day}
                type="button"
                aria-pressed={day === date}
                aria-label={displayDate(day, {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                })}
                onClick={() =>
                  navigate({
                    search: (previous) => ({ ...previous, date: day }),
                  })
                }
                className={`flex min-h-14 flex-col items-center justify-center rounded-xl px-1 py-2 transition ${day === date ? 'bg-[var(--lagoon)] text-[var(--surface)]' : 'text-[var(--sea-ink-soft)] hover:bg-[var(--foam)]'}`}
              >
                <span className="text-[10px] font-semibold uppercase">
                  {displayDate(day, { weekday: 'short' })}
                </span>
                <span className="text-base font-bold">
                  {Number(day.slice(-2))}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="island-kicker">Time range</span>
              {(search.from || search.to) && (
                <button
                  type="button"
                  onClick={() =>
                    navigate({
                      search: (previous) => ({
                        ...previous,
                        from: undefined,
                        to: undefined,
                      }),
                    })
                  }
                  className="text-xs font-semibold text-[var(--lagoon)] underline"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--sea-ink)]">
              <label className="flex flex-col gap-1 text-xs">
                From
                <input
                  type="time"
                  value={search.from ?? ''}
                  onChange={(event) =>
                    navigate({
                      search: (previous) => ({
                        ...previous,
                        from: event.target.value || undefined,
                      }),
                    })
                  }
                  className="min-h-11 rounded-xl border border-[var(--line)] px-3 py-1.5 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                To
                <input
                  type="time"
                  value={search.to ?? ''}
                  onChange={(event) =>
                    navigate({
                      search: (previous) => ({
                        ...previous,
                        to: event.target.value || undefined,
                      }),
                    })
                  }
                  className="min-h-11 rounded-xl border border-[var(--line)] px-3 py-1.5 text-sm"
                />
              </label>
            </div>
          </div>
          <label className="flex flex-col gap-2 text-sm text-[var(--sea-ink)]">
            <span className="island-kicker">Holes</span>
            <select
              value={search.holes ?? ''}
              onChange={(event) =>
                navigate({
                  search: (previous) => ({
                    ...previous,
                    holes:
                      event.target.value === '9' || event.target.value === '18'
                        ? event.target.value
                        : undefined,
                  }),
                })
              }
              className="min-h-11 rounded-xl border border-[var(--line)] px-3 py-1.5"
            >
              <option value="">All</option>
              <option value="9">9 holes</option>
              <option value="18">18 holes</option>
            </select>
          </label>
        </div>
        {invalidRange && (
          <p
            role="alert"
            className="text-sm text-amber-700 dark:text-amber-300"
          >
            The start time must be earlier than the end time.
          </p>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-4">
            <span className="island-kicker">Courses</span>
            {search.courses !== undefined && (
              <button
                type="button"
                onClick={() =>
                  navigate({
                    search: (previous) => ({ ...previous, courses: undefined }),
                  })
                }
                className="min-h-11 text-xs font-semibold text-[var(--lagoon)] underline"
              >
                Select all
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {courses.map((course) => (
              <button
                key={course.slug}
                type="button"
                aria-pressed={selected.includes(course.slug)}
                onClick={() => toggleCourse(course.slug)}
                className={`min-h-11 rounded-full px-3.5 py-1.5 text-sm font-semibold transition ${selected.includes(course.slug) ? 'bg-[var(--lagoon)] text-[var(--surface)]' : 'border border-[var(--line)] text-[var(--sea-ink-soft)] hover:border-[var(--lagoon)]'}`}
              >
                {course.name}
              </button>
            ))}
          </div>
        </div>
      </section>

      {unconfirmed && (
        <p
          role="status"
          className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          Some listings are old or unavailable. A failed check does not mean a
          course is sold out. Check the status below each course.
        </p>
      )}
      {shownCourses.length > 1 && (
        <p className="mb-2 text-xs text-[var(--sea-ink-soft)] md:hidden">
          Swipe across the table to compare all selected courses.
        </p>
      )}
      <div className="island-shell overflow-hidden rounded-2xl">
        <div
          className="relative overflow-x-auto"
          role="region"
          aria-label="Tee time comparison, scroll horizontally for more courses"
          tabIndex={0}
        >
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Published tee times for{' '}
              {displayDate(date, {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
              , Pacific time
            </caption>
            <thead>
              <tr className="bg-[var(--foam)] text-left text-[var(--sea-ink)]">
                <th
                  scope="col"
                  className="sticky left-0 z-10 min-w-24 bg-[var(--foam)] px-3 py-4 font-semibold"
                >
                  Time / holes
                </th>
                {shownCourses.map((course) => {
                  const status = courseFreshness.get(course.id)!
                  return (
                    <th
                      scope="col"
                      key={course.slug}
                      className="min-w-52 px-3 py-4 align-top font-semibold"
                    >
                      <a
                        href={course.bookingUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="display-title text-base text-[var(--sea-ink)] underline decoration-dotted decoration-[var(--lagoon)] underline-offset-4"
                      >
                        {course.name} ↗
                      </a>
                      <span
                        className={`mt-1 block max-w-60 text-xs font-normal ${status.state === 'fresh' ? 'text-[var(--sea-ink-soft)]' : 'text-amber-800 dark:text-amber-200'}`}
                      >
                        {status.label}
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {timeRows.map((time) => (
                <tr
                  key={slotKey(time)}
                  className="border-t border-[var(--line)] text-[var(--sea-ink)]"
                >
                  <th
                    scope="row"
                    className="sticky left-0 z-10 whitespace-nowrap bg-[var(--surface)] px-3 py-3 text-left font-semibold tabular-nums"
                  >
                    {fmtTime(time.time)}
                    <span className="block text-xs font-normal text-[var(--sea-ink-soft)]">
                      {time.holes} holes
                    </span>
                  </th>
                  {shownCourses.map((course) => {
                    const slot = cells.get(`${course.id}|${slotKey(time)}`)
                    return (
                      <td
                        key={course.slug}
                        className="px-3 py-3 align-top tabular-nums"
                      >
                        {slot ? (
                          <SlotLink
                            slot={slot}
                            bookingUrl={course.bookingUrl}
                            courseName={course.name}
                            uncertain={
                              courseFreshness.get(course.id)?.state !== 'fresh'
                            }
                          />
                        ) : (
                          <span className="text-[var(--sea-ink-soft)]">
                            <span aria-hidden="true">—</span>
                            <span className="sr-only">No listing reported</span>
                          </span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
              {timeRows.length === 0 && (
                <tr>
                  <td
                    colSpan={shownCourses.length + 1}
                    className="px-4 py-10 text-center text-[var(--sea-ink-soft)]"
                  >
                    {emptyMessage}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  )
}
