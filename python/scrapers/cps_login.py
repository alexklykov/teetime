#!/usr/bin/env python3
"""
cps_login.py -- create / refresh the saved login session for a CPS course.

The ingest pipeline refreshes an expired session on its own (via
LAKEPADDEN_EMAIL / LAKEPADDEN_PASSWORD). Use this script to:

  * seed the very first session, or
  * recover by hand when auto-login breaks (the password-step selectors in
    cps.login() are best-effort and the site can change them).

Run from the python/ directory:

    # log in by hand in a visible browser, then press Enter
    python -m scrapers.cps_login --course lake-padden --headed

    # log in with LAKEPADDEN_EMAIL / LAKEPADDEN_PASSWORD, no window
    python -m scrapers.cps_login --course lake-padden

    # one-time: import an existing Playwright storage_state file
    python -m scrapers.cps_login --course lake-padden --import-file lakepadden_session.json

DATABASE_URL_UNPOOLED must be set.
"""

import argparse
import json
import os
import sys

from playwright.sync_api import sync_playwright

import pipeline
from scrapers import cps


def _course(conn, slug):
    rows = pipeline.load_courses(conn, only=slug)
    if not rows:
        raise SystemExit(f"No active course with slug {slug!r}.")
    return rows[0]


def _import_file(conn, course, path):
    with open(path) as f:
        state = json.load(f)
    pipeline.save_session(conn, course["id"], state)
    print(f"Imported {path} -> CourseSession for {course['slug']}.")


def _headed_login(conn, course):
    base = cps.base_url(course)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        try:
            context = browser.new_context(timezone_id="America/Los_Angeles")
            page = context.new_page()
            page.goto(course["bookingUrl"], wait_until="domcontentloaded")
            print("A browser window opened. Log in there, then come back and press "
                  "Enter once you can see the tee-time search page.")
            input()
            if cps.is_logged_out(page):
                raise SystemExit("Still on the login gate -- session not saved.")
            pipeline.save_session(conn, course["id"], context.storage_state())
            print(f"Saved session -> CourseSession for {course['slug']}.")
        finally:
            browser.close()


def _auto_login(conn, course):
    email, password = os.environ.get(cps.EMAIL_ENV), os.environ.get(cps.PASSWORD_ENV)
    if not (email and password):
        raise SystemExit(f"Set {cps.EMAIL_ENV} and {cps.PASSWORD_ENV}, or use --headed.")
    base = cps.base_url(course)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=800)
        try:
            context = browser.new_context(timezone_id="America/Los_Angeles")
            page = context.new_page()
            if not cps.login(page, base, email, password):
                raise SystemExit("Login failed. Try --headed to watch it.")
            pipeline.save_session(conn, course["id"], context.storage_state())
            print(f"Saved session -> CourseSession for {course['slug']}.")
        finally:
            browser.close()


def main():
    ap = argparse.ArgumentParser(description="Create/refresh a CPS login session")
    ap.add_argument("--course", required=True, help="course slug, e.g. lake-padden")
    ap.add_argument("--headed", action="store_true", help="log in by hand in a visible browser")
    ap.add_argument("--import-file", help="load an existing storage_state JSON file instead")
    args = ap.parse_args()

    conn = pipeline.connect()
    try:
        course = _course(conn, args.course)
        if args.import_file:
            _import_file(conn, course, args.import_file)
        elif args.headed:
            _headed_login(conn, course)
        else:
            _auto_login(conn, course)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
