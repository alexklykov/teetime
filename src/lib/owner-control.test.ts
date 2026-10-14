import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleOwnerRequest } from './owner-control.server'
import type { OwnerDependencies } from './owner-control.server'

const origin = 'https://teetime-omega.vercel.app'
const key = 'test-only-owner-key-with-more-than-32-characters'
const now = Date.parse('2026-10-14T20:00:00Z')
const completed = {
  id: 12,
  status: 'completed',
  conclusion: 'failure',
  created_at: new Date(now - 1000).toISOString(),
  head_branch: 'main',
  path: '.github/workflows/scrape.yml',
}

function harness() {
  let claimed = false
  const calls: Array<{ url: string; body: unknown }> = []
  const deps: OwnerDependencies = {
    ownerKey: key,
    githubToken: 'test-token',
    origin,
    secureCookies: true,
    now: () => now,
    getCooldown: async () => (claimed ? new Date(now + 600_000) : null),
    claimCooldown: async () => {
      const granted = !claimed
      claimed = true
      return { claimed: granted, nextAllowedAt: new Date(now + 600_000) }
    },
    fetch: async (input, options) => {
      calls.push({
        url: String(input),
        body: options?.body ? JSON.parse(String(options.body)) : null,
      })
      if (options?.method === 'POST')
        return Response.json({ workflow_run_id: 42 })
      return Response.json({ workflow_runs: [completed] })
    },
  }
  return { deps, calls }
}

function post(
  body: unknown,
  cookie = '',
  requestOrigin: string | null = origin,
) {
  return new Request(`${origin}/api/owner`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      ...(requestOrigin === null ? {} : { Origin: requestOrigin }),
    },
    body: JSON.stringify(body),
  })
}

async function login(deps: OwnerDependencies) {
  const result = await handleOwnerRequest(post({ action: 'login', key }), deps)
  assert.equal(result.status, 200)
  const header = result.headers.get('set-cookie')!
  assert.match(header, /^__Host-ff-owner=/)
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/'])
    assert.ok(header.includes(flag))
  assert.ok(!header.includes('Domain='))
  return header.split(';')[0]
}

test('anonymous status and invalid owner keys never call GitHub or write the database', async () => {
  const { deps, calls } = harness()
  deps.claimCooldown = async () => {
    throw new Error('Must not reach database')
  }
  const status = await handleOwnerRequest(
    new Request(`${origin}/api/owner`),
    deps,
  )
  assert.deepEqual(await status.json(), {
    authenticated: false,
    configured: true,
  })
  assert.equal(status.headers.get('cache-control'), 'private, no-store')
  assert.equal(
    (await handleOwnerRequest(post({ action: 'login', key: 'wrong' }), deps))
      .status,
    401,
  )
  assert.equal(
    (await handleOwnerRequest(post({ action: 'refresh' }), deps)).status,
    401,
  )
  assert.deepEqual(calls, [])
})

test('tampered, expired, and rotated-key sessions cannot dispatch', async () => {
  const { deps, calls } = harness()
  const cookie = await login(deps)
  assert.equal(
    (await handleOwnerRequest(post({ action: 'refresh' }, `${cookie}a`), deps))
      .status,
    401,
  )
  deps.now = () => now + 8 * 60 * 60 * 1000
  assert.equal(
    (await handleOwnerRequest(post({ action: 'refresh' }, cookie), deps))
      .status,
    401,
  )
  deps.now = () => now
  deps.ownerKey = 'a-different-owner-secret-with-at-least-32-characters'
  assert.equal(
    (await handleOwnerRequest(post({ action: 'refresh' }, cookie), deps))
      .status,
    401,
  )
  assert.deepEqual(calls, [])
})

test('every mutation rejects cross-origin or missing Origin, including login and logout', async () => {
  const { deps, calls } = harness()
  const cookie = await login(deps)
  for (const requestOrigin of [
    null,
    'null',
    'https://attacker.invalid',
    `${origin}.attacker.invalid`,
  ]) {
    for (const body of [
      { action: 'login', key },
      { action: 'logout' },
      { action: 'refresh' },
    ]) {
      assert.equal(
        (await handleOwnerRequest(post(body, cookie, requestOrigin), deps))
          .status,
        403,
      )
    }
  }
  assert.deepEqual(calls, [])
})

test('concurrent manual refreshes produce one fixed workflow dispatch', async () => {
  const { deps, calls } = harness()
  const cookie = await login(deps)
  const results = await Promise.all(
    [1, 2].map(() =>
      handleOwnerRequest(post({ action: 'refresh' }, cookie), deps),
    ),
  )
  assert.deepEqual(results.map((result) => result.status).sort(), [202, 409])
  const dispatches = calls.filter((call) => call.body)
  assert.deepEqual(dispatches, [
    {
      url: 'https://api.github.com/repos/alexklykov/teetime/actions/workflows/scrape.yml/dispatches',
      body: {
        ref: 'main',
        inputs: { days: '7', course: '', dry_run: 'false' },
      },
    },
  ])
  const accepted = await results.find((result) => result.status === 202)!.json()
  assert.equal(accepted.run.id, 42)
  assert.equal(accepted.run.status, 'queued')
})

test('older active runs prevent dispatch even when the latest run has finished', async () => {
  const { deps } = harness()
  const cookie = await login(deps)
  deps.fetch = async (_input, options) => {
    assert.equal(options?.method, 'GET')
    return Response.json({
      workflow_runs: [
        completed,
        { ...completed, id: 11, status: 'waiting', conclusion: null },
      ],
    })
  }
  deps.claimCooldown = async () => {
    throw new Error('Must not claim')
  }
  const result = await handleOwnerRequest(
    post({ action: 'refresh' }, cookie),
    deps,
  )
  assert.equal(result.status, 409)
  assert.equal((await result.json()).run.id, 11)
})

test('unknown dispatch outcomes preserve cooldown and never invent a completed run', async () => {
  for (const mode of ['no-content', 'timeout', 'invalid-json']) {
    const { deps } = harness()
    const cookie = await login(deps)
    let dispatches = 0
    deps.fetch = async (_input, options) => {
      if (options?.method !== 'POST')
        return Response.json({ workflow_runs: [completed] })
      dispatches++
      if (mode === 'timeout') throw new Error('secret-provider-diagnostic')
      if (mode === 'invalid-json')
        return new Response('secret-provider-diagnostic')
      return new Response(null, { status: 204 })
    }
    const result = await handleOwnerRequest(
      post({ action: 'refresh' }, cookie),
      deps,
    )
    assert.equal(result.status, 503)
    const data = await result.json()
    assert.match(data.error, /outcome is unknown/)
    assert.ok(!JSON.stringify(data).includes('secret-provider-diagnostic'))
    assert.equal(data.run, undefined)
    assert.equal(
      (await handleOwnerRequest(post({ action: 'refresh' }, cookie), deps))
        .status,
      409,
    )
    assert.equal(dispatches, 1)
  }
})

test('status follows the requested run and hides GitHub credentials and raw errors', async () => {
  const { deps } = harness()
  const cookie = await login(deps)
  deps.fetch = async (input) => {
    assert.equal(
      String(input),
      'https://api.github.com/repos/alexklykov/teetime/actions/runs/42',
    )
    return Response.json({ ...completed, id: 42 })
  }
  const result = await handleOwnerRequest(
    new Request(`${origin}/api/owner?runId=42`, {
      headers: { Cookie: cookie },
    }),
    deps,
  )
  assert.equal((await result.json()).run.id, 42)
  deps.fetch = async () => {
    throw new Error('secret-token-in-error')
  }
  const failed = await handleOwnerRequest(
    new Request(`${origin}/api/owner`, { headers: { Cookie: cookie } }),
    deps,
  )
  assert.equal(failed.status, 503)
  const unavailable = await failed.json()
  assert.equal(unavailable.authenticated, true)
  assert.equal(unavailable.configured, true)
  assert.ok(!JSON.stringify(unavailable).includes('secret-token-in-error'))
})

test('rejects oversized or extra action fields and clears the session on logout', async () => {
  const { deps, calls } = harness()
  const cookie = await login(deps)
  assert.equal(
    (
      await handleOwnerRequest(
        post({ action: 'refresh', ref: 'untrusted' }, cookie),
        deps,
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await handleOwnerRequest(
        post({ action: 'login', key: 'x'.repeat(2100) }),
        deps,
      )
    ).status,
    413,
  )
  const result = await handleOwnerRequest(
    post({ action: 'logout' }, cookie),
    deps,
  )
  assert.equal(result.status, 200)
  assert.match(result.headers.get('set-cookie')!, /Max-Age=0/)
  assert.deepEqual(calls, [])
})
