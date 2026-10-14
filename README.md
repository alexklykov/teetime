# TeeTime

Compare available tee times at six courses around Bellingham, Washington. The TanStack Start app runs on Vercel, PostgreSQL stores the latest availability, and GitHub Actions runs Python/Playwright scrapers every 30 minutes. Booking links take you to each course's own website. Source: [alexklykov/teetime](https://github.com/alexklykov/teetime).

Live app: [Fairway Finder](https://teetime-omega.vercel.app). Changes pushed to `main` deploy automatically. [Scraper runs and manual refresh](https://github.com/alexklykov/teetime/actions/workflows/scrape.yml) are available in GitHub Actions.

## Local setup

Use Node.js 24, npm, Python 3.12, and a permanent Neon/PostgreSQL database. Copy `.env.example` to `.env.local` and fill in your own connection strings. An unclaimed Neon Launchpad database expires and should not be used for production. `package-lock.json` is the dependency lockfile; use `npm ci` for reproducible installs.

```sh
npm ci
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

`db:seed` only upserts course metadata. It never creates sample availability or deletes tee times, sessions, or scrape status. Until the first successful scrape, courses display as awaiting a refresh.

For a database created before migrations were added, compare its tables, columns, indexes, and foreign keys against `prisma/migrations/20261014000000_initial/migration.sql`. Only if they match, record that baseline once before applying the new migration:

```sh
npx dotenv -e .env.local -- prisma migrate resolve --applied 20261014000000_initial
npm run db:deploy
```

Do not baseline an empty database; run `db:deploy` directly. These migrations preserve the original unused `Todo` table to avoid deleting existing data. Production changes use migrations, not `db push` or `migrate reset`.

To run the scrapers locally, provide the same environment variables as the GitHub job (the scraper also reads `.env.local`):

```sh
python -m pip install -r python/requirements.txt
python -m playwright install chromium
python python/ingest.py --days 7
```

Linux requires a display for browser-based scraping; use `xvfb-run -a python python/ingest.py --days 7`. Use `--dry-run` to inspect results without database writes or `--course lake-padden --days 1` to check one course.

## Deploy

1. Create a permanent Neon Free project. Use its pooled connection string for Vercel's server-side `DATABASE_URL` and its direct connection string for migration/scraper `DATABASE_URL_UNPOOLED`.
2. Apply migrations and seed the six courses with the commands above against that database.
3. Push this repository to a public GitHub repository. In **Settings → Secrets and variables → Actions**, add `DATABASE_URL_UNPOOLED`, `LAKEPADDEN_EMAIL`, and `LAKEPADDEN_PASSWORD`. These values belong in secrets, never in committed files or workflow logs.
4. Import the repository into your personal Vercel Hobby account. Set `DATABASE_URL` for Production, use `npm run build`, and let the checked-in Nitro configuration produce Vercel's output. Apply migrations separately before deploying schema-dependent application changes.
5. In GitHub **Actions → scrape tee times → Run workflow**, start a run and verify its summary. Confirm that the deployed app shows successful refresh times for all six courses, then verify a scheduled run updates them again.

The deployed website uses a separate PostgreSQL role with read access only to courses, availability, and refresh status. Keep the writer connection and saved booking sessions limited to the scraper; preview deployments do not receive the production database secret.

The workflow is on the repository's default branch and requests runs at minutes 7 and 37 each hour. It processes today and the following six days in `America/Los_Angeles`, even when your computer is off. Vercel serves the app; it does not run the scraper.

## Availability and operations

- A successful course/day scrape atomically replaces that snapshot, including removing booked or disappeared slots. An empty successful result means no openings.
- A failed scrape retains the prior snapshot and last successful refresh. The UI shows stale or failed refresh status; availability must be confirmed on the booking site.
- Transient failures receive bounded retries. The job still checks other courses, then fails if any scrape failed. See the workflow's job summary and logs for the affected courses/dates.
- Dates before today are pruned from availability and scrape status. Course login sessions stay in PostgreSQL and are reused across runners.
- Enable GitHub Actions failure notifications in your GitHub notification settings and watch the repository. A job that never starts cannot emit a failure: check the Actions page if the website shows old refresh times.

[GitHub scheduling](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) is best effort: runs may be delayed or dropped, and public-repository schedules disable after 60 days without repository activity. Re-enable a disabled workflow from its Actions page. Keep an eye on Neon and Vercel usage so the project stays within free allowances; [Vercel Hobby](https://vercel.com/docs/plans/hobby) is intended for personal, non-commercial use.

Never commit `.env*`, browser session files, cookies, database exports, or login credentials. New shadcn components should be installed with the latest CLI, for example `pnpm dlx shadcn@latest add button`.
