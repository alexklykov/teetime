"""Per-platform tee-time scrapers.

Each module exposes:

    scrape(course: dict, start: date, days: int, conn) -> list[dict]

`course` is a row from pipeline.load_courses() (id, slug, name, bookingUrl, config).
`conn` is only used by `cps` (for the saved login session); the rest ignore it.
Returned dicts are normalized rows -- see pipeline.py for the recognized keys.
"""
