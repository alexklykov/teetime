import { Link } from '@tanstack/react-router'

export default function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="mt-20 border-t border-[var(--line)] bg-[var(--surface)] px-4 pb-14 pt-10 text-[var(--sea-ink-soft)]">
      <div className="page-wrap flex flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-left">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--lagoon)] text-white">
            <span className="material-symbols-outlined text-[18px]">
              golf_course
            </span>
          </span>
          <div>
            <p className="display-title m-0 font-bold text-[var(--lagoon)]">
              Fairway Finder
            </p>
            <p className="m-0 text-xs">
              Compare tee times &middot; book on the course site
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link
            to="/owner"
            className="min-h-11 py-3 underline underline-offset-4"
          >
            Owner
          </Link>
          <p className="m-0">&copy; {year} Fairway Finder</p>
        </div>
      </div>
    </footer>
  )
}
