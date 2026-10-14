import { createFileRoute } from '@tanstack/react-router'

async function handle(request: Request) {
  const [{ handleOwnerRequest }, { prisma }] = await Promise.all([
    import('#/lib/owner-control.server'),
    import('#/db'),
  ])
  return handleOwnerRequest(request, {
    ownerKey: process.env.OWNER_ACCESS_KEY,
    githubToken: process.env.GITHUB_ACTIONS_TOKEN,
    origin:
      process.env.NODE_ENV === 'production'
        ? 'https://teetime-omega.vercel.app'
        : 'http://localhost:3000',
    secureCookies: process.env.NODE_ENV === 'production',
    fetch: globalThis.fetch,
    now: Date.now,
    getCooldown: async () => {
      const rows = await prisma.$queryRaw<Array<{ nextAllowedAt: Date }>>`
        SELECT "lastRequestedAt" + interval '10 minutes' AS "nextAllowedAt"
        FROM public."RefreshControl" WHERE id = 1`
      return rows[0]?.nextAllowedAt ?? null
    },
    claimCooldown: async () => {
      const rows = await prisma.$queryRaw<
        Array<{ claimed: boolean; nextAllowedAt: Date }>
      >`
        SELECT claimed, "nextAllowedAt" FROM public.claim_manual_refresh()`
      if (!rows[0]) throw new Error('Cooldown unavailable')
      return rows[0]
    },
  })
}

export const Route = createFileRoute('/api/owner')({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
})
