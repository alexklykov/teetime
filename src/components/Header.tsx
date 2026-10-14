import { Link } from '@tanstack/react-router'
import ThemeToggle from './ThemeToggle'

export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] px-4 backdrop-blur-lg">
      <nav className="page-wrap flex flex-wrap items-center gap-x-4 gap-y-2 py-3 sm:py-4">
        <Link
          to="/"
          className="flex flex-shrink-0 items-center gap-2.5 no-underline"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--lagoon)] text-white">
            <span className="material-symbols-outlined text-[20px]">
              golf_course
            </span>
          </span>
          <span className="display-title text-lg font-bold text-[var(--lagoon)]">
            Fairway Finder
          </span>
        </Link>

        <div className="order-3 flex w-full flex-wrap items-center gap-x-6 gap-y-1 pb-1 text-sm sm:order-none sm:w-auto sm:flex-nowrap sm:pb-0">
          <Link
            to="/teetimes"
            className="nav-link"
            activeProps={{ className: 'nav-link is-active' }}
          >
            Tee Times
          </Link>
        </div>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <ThemeToggle />
        </div>
      </nav>
    </header>
  )
}
