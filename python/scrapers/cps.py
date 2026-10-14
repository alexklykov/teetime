#!/usr/bin/env python3
"""
Club Prophet / CPS (e.g. Lake Padden -- lakepaddenpremier.cps.golf, and
Sudden Valley -- suddenvalley.cps.golf).

The /TeeTimes API needs a `transactionId` the server issues to a live browser
session (a random UUID is rejected), so this drives a real Playwright browser and
reads the JSON off the network instead of scraping HTML. The site redirects
headless browsers to /bot-detection, so runs use a visible window (works under
`xvfb-run` in CI).

config:
  {}                -> straight to the tee-time search, no login (Sudden Valley)
  { "login": true } -> gated behind a password login (Lake Padden). The session
                       is stored in the DB ("CourseSession"); this module reuses
                       it, and on expiry logs in again with LAKEPADDEN_EMAIL /
                       LAKEPADDEN_PASSWORD and writes the fresh session back.
"""

import os
import re
import sys
from datetime import datetime, timedelta
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from playwright.sync_api import (
    sync_playwright,
    Error as PWError,
    TimeoutError as PWTimeoutError,
)

import pipeline
from scrapers.common import ProviderError, ScrapeResult, error_message

TEETIMES_URL_PART = "/TeeTimes"
DAY_CELL_SELECTOR = (
    "span.day-background-upper.is-visible"
    ":not(.is-disabled):not(.is-prev-month):not(.is-next-month)"
)
NEXT_MONTH_BUTTON_SELECTOR = ".topbar-container button >> nth=2"
MONTH_HEADER_SELECTOR = ".topbar-title .mat-button-wrapper"

EMAIL_ENV = "LAKEPADDEN_EMAIL"
PASSWORD_ENV = "LAKEPADDEN_PASSWORD"


def base_url(course):
    p = urlsplit(course["bookingUrl"])
    return f"{p.scheme}://{p.netloc}"


def _month_start(d):
    return d.replace(day=1)


def _months_between(a, b):
    return (b.year - a.year) * 12 + (b.month - a.month)


def is_logged_out(page):
    """The logged-out gate shows this exact prompt before anything else."""
    try:
        return page.get_by_text("Please Enter Email to Continue").is_visible(timeout=3000)
    except PWError:
        return False


def _page_state(page):
    path = urlsplit(page.url).path.lower()
    if "bot-detection" in path or "access-denied" in path:
        return "provider access restriction"
    if "login" in path or "verify-email" in path:
        return "login page"
    if "search-teetime" in path:
        return "tee-time search page"
    return "unexpected page"


def _check_access(page):
    if _page_state(page) == "provider access restriction" or _title_class(page) == "access challenge":
        raise ProviderError("CPS refuses access from this runner; a permitted provider integration is required")


def _title_class(page):
    title = page.title().lower()
    if any(marker in title for marker in ("access denied", "forbidden", "just a moment", "verify you are human")):
        return "access challenge"
    if "club prophet" in title:
        return "booking app"
    return "other"


def _navigate(page, url):
    response = page.goto(url, wait_until="domcontentloaded")
    if response is not None and response.status >= 400:
        raise ProviderError(f"CPS booking document returned HTTP {response.status} from this runner")
    _check_access(page)


def login(page, base, email, password):
    """
    Two-step login: /auth/verify-email (email -> Enter) then /auth/login
    (password -> Enter), landing back on /search-teetime. Submitting with Enter
    rather than a button click sidesteps the page having both a nav "Sign In" and
    a form "SIGN IN" button. Run cps_login.py --headed if this ever breaks.
    """
    _navigate(page, f"{base}/onlineresweb/login")

    page.fill('input[name="email"]', email)
    page.locator('input[name="email"]').press("Enter")

    try:
        page.wait_for_selector('input[name="password"]', timeout=10000)
    except PWTimeoutError:
        print("! No password field after the email step -- account may not exist, "
              "or the login flow changed. Try cps_login.py --headed.", file=sys.stderr)
        return False

    page.fill('input[name="password"]', password)
    page.locator('input[name="password"]').press("Enter")

    try:
        page.wait_for_url(re.compile(r"search-teetime|home|dashboard"), timeout=15000)
    except PWTimeoutError:
        return False
    _check_access(page)
    return not is_logged_out(page)


def _parse_items(items, target):
    # A day with no availability returns content as a dict, not a list.
    if items == {}:
        return []
    if not isinstance(items, list):
        raise ValueError("Unexpected CPS availability content")
    rows = []
    for item in items:
        start_time = item.get("startTime") or ""
        time = start_time.split("T")[-1][:5]
        if re.match(r"\d{4}-\d{2}-\d{2}[T ]", start_time):
            parsed = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone(ZoneInfo("America/Los_Angeles"))
            if parsed.date() != target:
                raise ValueError("CPS response belongs to another date")
            time = parsed.strftime("%H:%M")
        rate = item.get("defaultBookingRate") or {}
        prices = item.get("shItemPrices") or []
        price0 = prices[0] if prices else {}
        rows.append({
            "date": target.isoformat(),
            "time": time,
            "holes": item.get("holes"),
            "price": price0.get("displayPrice"),
            "minPlayers": item.get("minPlayer"),
            "maxPlayers": item.get("maxPlayer"),
            "rateName": rate.get("bookingRateTypeName") or rate.get("rateCode"),
            "raw": item,
        })
    return rows


def _request_teetimes(page, action, timeout=15000):
    # A prior calendar request can finish after the next click. Only accept the
    # response for a request that starts during this action.
    requests = []

    def capture(request):
        if TEETIMES_URL_PART in request.url:
            requests.append(request)
            return True
        return False

    try:
        with page.expect_request(capture, timeout=timeout):
            with page.expect_response(
                lambda response: bool(requests) and response.request == requests[0],
                timeout=timeout,
            ) as info:
                action()
                _check_access(page)
    except PWTimeoutError:
        _check_access(page)
        # Static labels only: never log URLs, request bodies, cookies or fields.
        stage = "response did not arrive" if requests else "request was not started"
        print(f"  CPS: tee-time API {stage} ({_page_state(page)})", file=sys.stderr)
        print(f"  CPS: title={_title_class(page)}, external scripts={page.locator('script[src]').count()}",
              file=sys.stderr)
        raise
    response = info.value
    if response.status != 200:
        raise ProviderError(f"CPS availability API returned HTTP {response.status}")
    return response.json()


def _open_widget(page, widget):
    for attempt in range(2):
        try:
            _request_teetimes(
                page, lambda: _navigate(page, widget), 30000
            )
            break
        except PWError:
            if attempt == 1:
                raise ProviderError(
                    f"CPS initial tee-time API did not load ({_page_state(page)})"
                ) from None
            page.wait_for_timeout(1000)
    try:
        page.wait_for_selector(MONTH_HEADER_SELECTOR, timeout=15000)
    except PWTimeoutError:
        raise ProviderError("CPS API responded but the booking calendar did not appear") from None
    header = page.locator(MONTH_HEADER_SELECTOR).inner_text().strip()
    return datetime.strptime(header, "%B %Y").date().replace(day=1)


def _read_days(page, widget, start, days):
    """Return complete daily snapshots; retain old data when a day cannot load."""
    cur_month = _open_widget(page, widget)
    result = ScrapeResult()
    for i in range(days):
        target = start + timedelta(days=i)
        for attempt in range(2):
            try:
                if attempt:
                    page.wait_for_timeout(1000)
                    cur_month = _open_widget(page, widget)
                months = _months_between(cur_month, _month_start(target))
                if months < 0:
                    raise ValueError("CPS calendar is beyond requested date")
                for _ in range(months):
                    page.locator(NEXT_MONTH_BUTTON_SELECTOR).click()
                    cur_month = (cur_month.replace(day=28) + timedelta(days=4)).replace(day=1)
                    page.locator(MONTH_HEADER_SELECTOR).filter(
                        has_text=re.compile(rf"^{cur_month.strftime('%B %Y')}$")
                    ).wait_for(state="visible", timeout=10000)

                candidates = page.locator(DAY_CELL_SELECTOR).filter(
                    has_text=re.compile(rf"^{target.day}$")
                )
                if candidates.count() == 0:
                    # An explicitly disabled date is a valid unavailable day.
                    disabled = page.locator(
                        "span.day-background-upper.is-visible.is-disabled"
                        ":not(.is-prev-month):not(.is-next-month)"
                    ).filter(has_text=re.compile(rf"^{target.day}$"))
                    if disabled.count():
                        result.succeed(target, [])
                        break
                    raise ValueError("Requested date missing from CPS calendar")

                data = _request_teetimes(page, candidates.first.click)
                if not isinstance(data, dict) or "content" not in data:
                    raise ValueError("Missing CPS availability response")
                result.succeed(target, _parse_items(data["content"], target))
                break
            except PWError as exc:
                if attempt == 1:
                    result.errors[target.isoformat()] = error_message(exc)
            except Exception as exc:
                result.errors[target.isoformat()] = error_message(exc)
                break
    return result


def scrape(course, start, days, conn, headless=False, *, persist_session=True):
    cfg = course.get("config") or {}
    needs_login = bool(cfg.get("login"))
    base = base_url(course)
    widget = course["bookingUrl"]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless, slow_mo=0 if headless else 800)
        try:
            state = pipeline.get_session(conn, course["id"]) if needs_login else None
            context = browser.new_context(
                timezone_id="America/Los_Angeles",
                **({"storage_state": state} if state else {})
            )
            page = context.new_page()
            page.on("pageerror", lambda _: print("  CPS: booking app JavaScript error", file=sys.stderr))
            page.on("requestfailed", lambda request: print(
                "  CPS: booking app script failed to load", file=sys.stderr
            ) if request.resource_type == "script" else None)
            page.on("response", lambda response: print(
                f"  CPS: booking app script returned HTTP {response.status}", file=sys.stderr
            ) if response.request.resource_type == "script" and response.status >= 400 else None)
            try:
                _navigate(page, widget)
            except PWTimeoutError:
                _check_access(page)
                raise ProviderError("CPS booking page did not load") from None
            page.wait_for_timeout(2000)  # let the Angular app decide login vs widget
            _check_access(page)

            if needs_login and is_logged_out(page):
                email, password = os.environ.get(EMAIL_ENV), os.environ.get(PASSWORD_ENV)
                if not (email and password):
                    raise ProviderError(
                        f"{course['slug']}: no saved session and {EMAIL_ENV}/{PASSWORD_ENV} "
                        "unset. Run: python -m scrapers.cps_login --course "
                        f"{course['slug']} --headed"
                    )
                print(f"  {course['slug']}: session expired, logging in...", file=sys.stderr)
                if not login(page, base, email, password):
                    raise ProviderError("CPS login did not succeed; refresh the saved session or check credentials")
                if persist_session:
                    pipeline.save_session(conn, course["id"], context.storage_state())

            rows = _read_days(page, widget, start, days)

            # Token refreshes while the browser is open -- persist the latest.
            if needs_login and persist_session:
                pipeline.save_session(conn, course["id"], context.storage_state())
            return rows
        finally:
            browser.close()
