import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'

type Run = {
  id: number
  url: string
  status: string
  conclusion: string | null
  createdAt: string
}

type OwnerStatus =
  | { authenticated: false; configured: boolean }
  | {
      authenticated: true
      configured: boolean
      run: Run | null
      nextAllowedAt: string | null
    }

type OwnerResponse = {
  authenticated?: boolean
  configured?: boolean
  run?: Run | null
  nextAllowedAt?: string | null
  error?: string
}

class OwnerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: OwnerResponse,
  ) {
    super(
      typeof body.error === 'string'
        ? body.error
        : 'Owner controls are temporarily unavailable. Please try again.',
    )
  }
}

function retainKnownStatus(
  previous: OwnerStatus | null,
  body: OwnerResponse,
): OwnerStatus | null {
  if (body.authenticated !== true && !previous?.authenticated) return previous
  const known = previous?.authenticated ? previous : null
  return {
    authenticated: true,
    configured: body.configured ?? known?.configured ?? false,
    run: body.run ?? known?.run ?? null,
    nextAllowedAt: body.nextAllowedAt ?? known?.nextAllowedAt ?? null,
  }
}

export const Route = createFileRoute('/owner')({
  component: Owner,
  head: () => ({
    meta: [
      { title: 'Owner controls · Fairway Finder' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
})

const buttonClass =
  'min-h-11 rounded-full bg-[var(--lagoon)] px-5 py-2 font-semibold text-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-50'

function formatDate(value: string) {
  return new Date(value).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

function runLabel(run: Run) {
  if (run.status === 'in_progress') return 'Running'
  if (run.status !== 'completed') return 'Queued'
  if (run.conclusion === 'success') return 'Finished successfully'
  if (run.conclusion === 'cancelled') return 'Canceled'
  if (run.conclusion === 'skipped') return 'Skipped'
  return 'Finished with errors; some courses may have updated'
}

async function ownerRequest(
  signal: AbortSignal,
  action?: string,
  key?: string,
  runId?: number | null,
) {
  const response = await fetch(
    runId ? `/api/owner?runId=${runId}` : '/api/owner',
    {
      method: action ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      ...(action && {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(key !== undefined && { key }) }),
      }),
    },
  )
  const body = (await response.json().catch(() => ({}))) as OwnerResponse
  if (!response.ok) {
    throw new OwnerRequestError(response.status, body)
  }
  return body
}

function Owner() {
  const [status, setStatus] = useState<OwnerStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const pendingRead = useRef<AbortController | null>(null)
  const pendingAction = useRef<AbortController | null>(null)
  const readVersion = useRef(0)
  const requestedRunId = useRef<number | null>(null)

  const loadStatus = useCallback(async () => {
    pendingRead.current?.abort()
    const controller = new AbortController()
    pendingRead.current = controller
    const version = ++readVersion.current
    setChecking(true)
    try {
      const result = (await ownerRequest(
        controller.signal,
        undefined,
        undefined,
        requestedRunId.current,
      )) as OwnerStatus
      if (!controller.signal.aborted && version === readVersion.current) {
        if (!result.authenticated) requestedRunId.current = null
        setStatus(result)
        setNow(Date.now())
        setLoadError(null)
      }
    } catch (error) {
      if (!controller.signal.aborted && version === readVersion.current) {
        if (
          error instanceof OwnerRequestError &&
          error.body.authenticated === true
        ) {
          setStatus((previous) => retainKnownStatus(previous, error.body))
          setNow(Date.now())
        }
        setLoadError(
          error instanceof Error
            ? error.message
            : 'Could not check refresh status.',
        )
      }
    } finally {
      if (!controller.signal.aborted && version === readVersion.current)
        setChecking(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    return () => {
      ++readVersion.current
      pendingRead.current?.abort()
      pendingAction.current?.abort()
    }
  }, [loadStatus])

  const run = status?.authenticated ? status.run : null
  const active = Boolean(
    status?.authenticated && run && run.status !== 'completed',
  )
  const nextAllowedAt = status?.authenticated ? status.nextAllowedAt : null
  const coolingDown = Boolean(
    nextAllowedAt && new Date(nextAllowedAt).getTime() > now,
  )

  useEffect(() => {
    if (!active || busy) return
    let stopped = false
    const poll = async () => {
      await loadStatus()
      if (!stopped) timer = window.setTimeout(poll, 10_000)
    }
    let timer = window.setTimeout(poll, 10_000)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [active, busy, loadStatus])

  useEffect(() => {
    if (!nextAllowedAt) return
    const remaining = new Date(nextAllowedAt).getTime() - Date.now()
    if (remaining <= 0) return
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 100)
    return () => window.clearTimeout(timer)
  }, [nextAllowedAt])

  const performAction = async (action: 'login' | 'logout' | 'refresh') => {
    if (pendingAction.current) return
    const controller = new AbortController()
    pendingAction.current = controller
    ++readVersion.current
    pendingRead.current?.abort()
    setChecking(false)
    setBusy(action)
    setActionError(null)
    if (action === 'refresh' || action === 'logout')
      requestedRunId.current = null
    try {
      const result = await ownerRequest(
        controller.signal,
        action,
        action === 'login' ? key : undefined,
      )
      if (controller.signal.aborted) return
      if (action === 'refresh' && result.run) {
        requestedRunId.current = result.run.id
        setStatus((previous) => retainKnownStatus(previous, result))
      }
      if (action === 'logout') {
        setStatus((previous) => ({
          authenticated: false,
          configured: previous?.configured ?? false,
        }))
      }
      if (action === 'login' || action === 'logout') setKey('')
      await loadStatus()
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof OwnerRequestError) {
          if (error.body.run) requestedRunId.current = error.body.run.id
          setStatus((previous) => retainKnownStatus(previous, error.body))
          setNow(Date.now())
        }
        setActionError(
          error instanceof Error
            ? error.message
            : 'The request could not be completed.',
        )
        await loadStatus()
      }
    } finally {
      if (!controller.signal.aborted) setBusy(null)
      if (pendingAction.current === controller) pendingAction.current = null
    }
  }

  return (
    <main className="page-wrap max-w-3xl px-4 py-10">
      <p className="island-kicker mb-2">Owner controls</p>
      <h1 className="display-title mb-3 text-3xl font-bold text-[var(--sea-ink)]">
        Request a fresh check
      </h1>
      <p className="mb-6 text-sm text-[var(--sea-ink-soft)]">
        These controls are for the site owner. A request checks all active
        courses for today and the next six days. It can take several minutes,
        and a request cannot guarantee that every course will respond.
      </p>

      {(loadError || actionError) && (
        <div
          role="alert"
          className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          {actionError || loadError}
        </div>
      )}

      <section
        className="island-shell rounded-2xl p-5 sm:p-6"
        aria-label="Owner access and refresh status"
      >
        {status === null ? (
          <p role="status">
            {loadError ? 'Status is unavailable.' : 'Checking owner access…'}
          </p>
        ) : !status.authenticated ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void performAction('login')
            }}
            className="flex max-w-md flex-col items-start gap-4"
          >
            <label className="flex w-full flex-col gap-2 text-sm font-semibold">
              Owner access key
              <input
                type="password"
                autoComplete="current-password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                required
                disabled={busy !== null}
                className="min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 font-normal"
              />
            </label>
            <button
              type="submit"
              disabled={busy !== null || !key}
              className={buttonClass}
            >
              {busy === 'login' ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="text-xs text-[var(--sea-ink-soft)]">
              The access key is sent only to this site’s server. Your signed-in
              session uses a secure cookie.
            </p>
          </form>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-semibold">Signed in as owner</p>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => performAction('logout')}
                className="min-h-11 text-sm text-[var(--lagoon)] underline underline-offset-4 disabled:opacity-50"
              >
                {busy === 'logout' ? 'Signing out…' : 'Sign out'}
              </button>
            </div>

            {run ? (
              <div
                aria-live="polite"
                className="rounded-xl bg-[var(--foam)] p-4 text-sm"
              >
                <p className="font-semibold">{runLabel(run)}</p>
                <p className="mt-1 text-[var(--sea-ink-soft)]">
                  Requested {formatDate(run.createdAt)}
                </p>
                {run.status === 'completed' && run.conclusion !== 'success' && (
                  <p className="mt-2 text-[var(--sea-ink-soft)]">
                    Check each course’s refresh status. Unsuccessful checks keep
                    the previous listings.
                  </p>
                )}
                {active && (
                  <p className="mt-2 text-[var(--sea-ink-soft)]">
                    This page checks progress every 10 seconds while the run is
                    active.
                  </p>
                )}
                <a
                  href={run.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-block min-h-6 underline underline-offset-4"
                >
                  View run details on GitHub ↗
                </a>
              </div>
            ) : (
              <p className="text-sm text-[var(--sea-ink-soft)]">
                No refresh run is available yet.
              </p>
            )}

            <div>
              <button
                type="button"
                disabled={
                  busy !== null ||
                  !status.configured ||
                  active ||
                  coolingDown ||
                  Boolean(loadError)
                }
                onClick={() => performAction('refresh')}
                className={buttonClass}
              >
                {busy === 'refresh'
                  ? 'Requesting refresh…'
                  : active
                    ? 'Refresh already queued or running'
                    : 'Check all courses now'}
              </button>
              {coolingDown && nextAllowedAt && (
                <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
                  Next request available after {formatDate(nextAllowedAt)}.
                </p>
              )}
              <p className="mt-3 text-xs text-[var(--sea-ink-soft)]">
                Requests share a cooldown to avoid overlapping checks. Closing
                this page does not cancel a queued run.
              </p>
            </div>
          </div>
        )}

        {status && !status.configured && (
          <p className="mt-5 text-sm text-[var(--sea-ink-soft)]">
            On-demand refresh is not configured yet. Scheduled checks and saved
            listings remain available.
          </p>
        )}
        <button
          type="button"
          disabled={checking || busy !== null}
          onClick={() => loadStatus()}
          className="mt-5 min-h-11 text-sm font-semibold text-[var(--lagoon)] underline underline-offset-4 disabled:opacity-50"
        >
          {checking ? 'Checking status…' : 'Reload status'}
        </button>
      </section>
      <a
        href="https://github.com/alexklykov/teetime/actions/workflows/scrape.yml"
        target="_blank"
        rel="noreferrer"
        className="mt-5 block min-h-11 py-2 text-sm font-semibold underline underline-offset-4"
      >
        View all refresh runs on GitHub ↗
      </a>
      <Link
        to="/teetimes"
        className="mt-6 inline-block min-h-11 py-2 text-sm font-semibold underline underline-offset-4"
      >
        Back to tee times
      </Link>
    </main>
  )
}
