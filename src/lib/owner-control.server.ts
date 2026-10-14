import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const REPOSITORY = 'alexklykov/teetime'
const WORKFLOW = 'scrape.yml'
const API = `https://api.github.com/repos/${REPOSITORY}/actions`
const SESSION_MS = 8 * 60 * 60 * 1000

const actionSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('login'), key: z.string().min(1).max(256) })
    .strict(),
  z.object({ action: z.literal('logout') }).strict(),
  z.object({ action: z.literal('refresh') }).strict(),
])
const runSchema = z.object({
  id: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable(),
  created_at: z.string().datetime(),
  head_branch: z.literal('main'),
  path: z
    .string()
    .refine((path) => path.split('@')[0] === '.github/workflows/scrape.yml'),
})

export type OwnerDependencies = {
  ownerKey: string | undefined
  githubToken: string | undefined
  origin: string
  secureCookies: boolean
  fetch: typeof fetch
  now: () => number
  getCooldown: () => Promise<Date | null>
  claimCooldown: () => Promise<{ claimed: boolean; nextAllowedAt: Date }>
}

function json(body: Record<string, unknown>, status = 200, cookie?: string) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      ...(cookie ? { 'Set-Cookie': cookie } : {}),
    },
  })
}

function equal(left: string, right: string) {
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest(),
  )
}

function cookieName(deps: OwnerDependencies) {
  return deps.secureCookies ? '__Host-ff-owner' : 'ff-owner-dev'
}

function signature(expires: string, key: string) {
  return createHmac('sha256', key)
    .update(`owner-session:${expires}`)
    .digest('hex')
}

function sessionCookie(deps: OwnerDependencies, clear = false) {
  const expires = String(deps.now() + SESSION_MS)
  const value = clear ? '' : `${expires}.${signature(expires, deps.ownerKey!)}`
  return `${cookieName(deps)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${deps.secureCookies ? '; Secure' : ''}`
}

function authenticated(request: Request, deps: OwnerDependencies) {
  if (!deps.ownerKey || deps.ownerKey.length < 32) return false
  const prefix = `${cookieName(deps)}=`
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length)
  const match = value?.match(/^(\d{13})\.([a-f0-9]{64})$/)
  if (!match) return false
  const expires = Number(match[1])
  return (
    expires > deps.now() &&
    expires <= deps.now() + SESSION_MS &&
    equal(match[2], signature(match[1], deps.ownerKey))
  )
}

function publicRun(value: unknown) {
  const run = runSchema.parse(value)
  return {
    id: run.id,
    url: `https://github.com/${REPOSITORY}/actions/runs/${run.id}`,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
  }
}

async function github(deps: OwnerDependencies, path: string, body?: unknown) {
  return deps.fetch(`${API}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${deps.githubToken}`,
      'X-GitHub-Api-Version': '2026-03-10',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
    redirect: 'error',
  })
}

async function recentRuns(deps: OwnerDependencies) {
  const response = await github(
    deps,
    `workflows/${WORKFLOW}/runs?branch=main&per_page=100`,
  )
  if (!response.ok) throw new Error('GitHub status unavailable')
  const data = z
    .object({ workflow_runs: z.array(z.unknown()) })
    .parse(await response.json())
  return data.workflow_runs.map(publicRun)
}

export async function handleOwnerRequest(
  request: Request,
  deps: OwnerDependencies,
) {
  const configured = Boolean(
    deps.ownerKey && deps.ownerKey.length >= 32 && deps.githubToken,
  )
  const authorized = authenticated(request, deps)

  if (request.method === 'GET') {
    if (!authorized) return json({ authenticated: false, configured })
    if (!configured)
      return json({
        authenticated: true,
        configured: false,
        run: null,
        nextAllowedAt: null,
      })
    try {
      const id = new URL(request.url).searchParams.get('runId')
      let run
      if (id !== null) {
        if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) {
          return json({ error: 'Invalid run ID.' }, 400)
        }
        const response = await github(deps, `runs/${id}`)
        if (!response.ok) throw new Error('GitHub status unavailable')
        run = publicRun(await response.json())
      } else {
        const runs = await recentRuns(deps)
        run =
          runs.find((item) => item.status !== 'completed') ?? runs.at(0) ?? null
      }
      return json({
        authenticated: true,
        configured,
        run,
        nextAllowedAt: (await deps.getCooldown())?.toISOString() ?? null,
      })
    } catch {
      return json(
        {
          authenticated: true,
          configured,
          run: null,
          nextAllowedAt: null,
          error:
            'Could not check refresh status. Verify the GitHub connection and try again.',
        },
        503,
      )
    }
  }

  if (request.method !== 'POST')
    return json({ error: 'Method not allowed.' }, 405)
  if (request.headers.get('origin') !== deps.origin) {
    return json(
      { error: 'This action must be requested from this website.' },
      403,
    )
  }
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return json({ error: 'Expected a JSON request.' }, 415)
  }
  let action: z.infer<typeof actionSchema>
  try {
    if (Number(request.headers.get('content-length')) > 2048)
      return json({ error: 'Request too large.' }, 413)
    const body = await request.text()
    if (Buffer.byteLength(body) > 2048)
      return json({ error: 'Request too large.' }, 413)
    action = actionSchema.parse(JSON.parse(body))
  } catch {
    return json({ error: 'Invalid request.' }, 400)
  }

  if (action.action === 'login') {
    if (!deps.ownerKey || deps.ownerKey.length < 32)
      return json({ error: 'Owner access is not configured.' }, 503)
    if (!equal(action.key, deps.ownerKey))
      return json({ error: 'The owner access key is incorrect.' }, 401)
    return json({ ok: true }, 200, sessionCookie(deps))
  }
  if (!authorized) return json({ error: 'Sign in as the owner first.' }, 401)
  if (action.action === 'logout')
    return json({ ok: true }, 200, sessionCookie(deps, true))
  if (!configured)
    return json(
      { error: 'The GitHub refresh connection is not configured yet.' },
      503,
    )

  let nextAllowedAt: string
  try {
    const active = (await recentRuns(deps)).find(
      (run) => run.status !== 'completed',
    )
    if (active)
      return json(
        { error: 'A refresh is already queued or running.', run: active },
        409,
      )
    const claim = await deps.claimCooldown()
    nextAllowedAt = claim.nextAllowedAt.toISOString()
    if (!claim.claimed)
      return json(
        {
          error:
            'A refresh was requested recently. Please wait for the cooldown.',
          nextAllowedAt,
        },
        409,
      )
  } catch {
    return json(
      { error: 'Could not prepare a refresh. No new job was requested.' },
      503,
    )
  }

  try {
    const response = await github(deps, `workflows/${WORKFLOW}/dispatches`, {
      ref: 'main',
      inputs: { days: '7', course: '', dry_run: 'false' },
    })
    if (response.status === 401 || response.status === 403) {
      return json(
        {
          error:
            'GitHub denied the refresh request. Check the token expiry and Actions permission.',
          nextAllowedAt,
        },
        503,
      )
    }
    if (response.status !== 200) throw new Error('Dispatch outcome uncertain')
    const { workflow_run_id: id } = z
      .object({ workflow_run_id: z.number().int().positive() })
      .parse(await response.json())
    return json(
      {
        run: {
          id,
          url: `https://github.com/${REPOSITORY}/actions/runs/${id}`,
          status: 'queued',
          conclusion: null,
          createdAt: new Date(deps.now()).toISOString(),
        },
        nextAllowedAt,
      },
      202,
    )
  } catch {
    // Keep the durable cooldown: a lost response can still mean GitHub started a job.
    return json(
      {
        error:
          'Request outcome is unknown. Check GitHub Actions before retrying.',
        nextAllowedAt,
      },
      503,
    )
  }
}
