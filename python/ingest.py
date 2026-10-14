#!/usr/bin/env python3
"""Refresh seven course-local days; exit nonzero if any course/day failed.

    python python/ingest.py --days 7
    python python/ingest.py --days 1 --course loomis-trail --dry-run

Requires DATABASE_URL_UNPOOLED and CPS login credentials when its saved session
expires. Dry runs use a read-only DB connection and do not save browser sessions.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pipeline
from scrapers import chronogolf, cps, foreup, golfrev, teesnap
from scrapers.common import ScrapeResult, error_message

PLATFORMS = {
    "teesnap": teesnap.scrape,
    "chronogolf": chronogolf.scrape,
    "golfrev": golfrev.scrape,
    "foreup": foreup.scrape,
    "cps": cps.scrape,
}


def course_today():
    return datetime.now(ZoneInfo("America/Los_Angeles")).date()


def write_summary(lines):
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Refresh tee-time snapshots in Neon")
    ap.add_argument("--days", type=int, default=7, choices=range(1, 15),
                    metavar="1-14", help="days including today (default 7)")
    ap.add_argument("--course", help="only this course slug")
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch and print results without any database writes")
    args = ap.parse_args(argv)

    start = course_today()
    dates = {(start + timedelta(days=i)).isoformat() for i in range(args.days)}
    failed = False
    summary = ["## Tee-time refresh", "", f"Dates start {start} (America/Los_Angeles).",
               "", "| Course | Refreshed days | Failed days | Rows |",
               "| --- | ---: | ---: | ---: |"]
    conn = pipeline.connect(read_only=args.dry_run)
    try:
        courses = pipeline.load_courses(conn, only=args.course)
        if not courses:
            print("No matching active courses.", file=sys.stderr)
            return 1
        for course in courses:
            fn = PLATFORMS.get(course["platform"])
            try:
                if fn is None:
                    raise RuntimeError("No scraper configured for platform")
                result = fn(course, start, args.days, conn,
                            persist_session=not args.dry_run)
                if not isinstance(result, ScrapeResult):
                    raise TypeError("Scraper must return ScrapeResult")
                for day in dates - result.successful_dates - result.errors.keys():
                    result.errors[day] = "Provider did not return this date"
                if result.successful_dates & result.errors.keys():
                    raise ValueError("Date marked both successful and failed")
                if (result.successful_dates | result.errors.keys()) - dates:
                    raise ValueError("Scraper returned dates outside requested window")
            except Exception as exc:
                result = ScrapeResult(errors={day: error_message(exc) for day in dates})

            if args.dry_run:
                print(json.dumps({"course": course["slug"],
                                  "successful_dates": sorted(result.successful_dates),
                                  "errors": result.errors,
                                  "rows": [{k: v for k, v in row.items() if k != "raw"}
                                           for row in result.rows]}, default=str))
            else:
                for day in sorted(result.successful_dates):
                    rows = [row for row in result.rows if row["date"] == day]
                    try:
                        pipeline.replace_day(conn, course["id"], day, rows)
                    except Exception as exc:
                        result.errors[day] = f"Database snapshot failed ({type(exc).__name__})"
                result.successful_dates.difference_update(result.errors)
                for day, error in result.errors.items():
                    try:
                        pipeline.record_failure(conn, course["id"], day, error)
                    except Exception as exc:
                        print(f"{course['slug']} {day}: could not record failure "
                              f"({type(exc).__name__})", file=sys.stderr)

            failed = failed or bool(result.errors)
            for day, error in sorted(result.errors.items()):
                print(f"{course['slug']} {day}: FAILED {error}", file=sys.stderr)
            print(f"{course['slug']}: {len(result.successful_dates)} days refreshed, "
                  f"{len(result.errors)} failed, {len(result.rows)} rows")
            slug = course["slug"].replace("|", " ").replace("\n", " ")
            summary.append(f"| {slug} | {len(result.successful_dates)} | "
                           f"{len(result.errors)} | {len(result.rows)} |")

        if not args.dry_run:
            try:
                pipeline.prune_past_days(conn, start.isoformat())
            except Exception as exc:
                failed = True
                print(f"Past-date cleanup failed ({type(exc).__name__})", file=sys.stderr)
    finally:
        conn.close()
        if args.dry_run:
            summary.append("\nDry run: no database or saved-session writes.")
        write_summary(summary)
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        # Connection failures can include DSNs; never print exception messages.
        print(f"Ingestion could not finish ({type(exc).__name__})", file=sys.stderr)
        sys.exit(1)
