#!/usr/bin/env python3
"""
GolfRev (e.g. Raspberry Ridge -- golfrev.com/go/tee_times/?htc=371&courseid=3763).

No login. A classic-ASP endpoint returns a ready-to-render HTML fragment:
  GET https://www.golfrev.com/go/tee_times/teetime_table_html.asp
      ?c={courseId}&h={htc}&s={M/D/YYYY}&specials=&reset=yes&snapshot=no

Each tee time is a Bootstrap card: h5.card-title (time, 12h), p.card-text
(max players), strong.cust-icon-style (holes), p.cust-card-trim (price).

config: { courseId, htc }
"""

import re
from datetime import datetime

from bs4 import BeautifulSoup

from scrapers.common import collect_days, get

ENDPOINT = "https://www.golfrev.com/go/tee_times/teetime_table_html.asp"
HEADERS = {
    "Accept": "text/html, */*",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "X-Requested-With": "XMLHttpRequest",
}
_PLAYERS_RE = re.compile(r"(\d+)\s*player")
_PRICE_RE = re.compile(r"[\d.,]+")


def _to_24h(text):
    """'6:00 AM' -> '06:00'.  Falls back to the first HH:MM it can find."""
    text = text.strip()
    for fmt in ("%I:%M %p", "%I:%M%p", "%H:%M"):
        try:
            return datetime.strptime(text, fmt).strftime("%H:%M")
        except ValueError:
            pass
    m = re.search(r"\d{1,2}:\d{2}", text)
    return m.group(0).zfill(5) if m else None


def _fetch(cfg, d, referer):
    resp = get(
        ENDPOINT,
        params={
            "c": cfg["courseId"], "h": cfg["htc"],
            "s": f"{d.month}/{d.day}/{d.year}",  # M/D/YYYY, not zero-padded
            "specials": "", "reset": "yes", "snapshot": "no",
        },
        headers={**HEADERS, "Referer": referer},
    )
    return resp.text


def _parse(html, d):
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select("div.card")
    if not cards:
        # An error/challenge page must not erase a previously valid snapshot.
        empty_message = re.search(
            r"(?:no (?:available )?tee\s*times|tee\s*times (?:are )?not available|sold out)",
            soup.get_text(" ", strip=True), re.IGNORECASE,
        )
        if empty_message:
            return []
        raise ValueError("Unrecognized GolfRev availability response")
    rows = []
    for card in cards:
        title = card.select_one("h5.card-title")
        if not title:
            raise ValueError("GolfRev slot is missing its time")

        players = None
        for p in card.select("p.card-text"):
            if "text-secondary" in (p.get("class") or []):
                continue
            m = _PLAYERS_RE.search(p.get_text(strip=True))
            if m:
                players = int(m.group(1))
                break

        holes_el = card.select_one("[data-bs-title*='Hole']") or card.select_one(".cust-icon-style")
        holes = None
        if holes_el:
            m = re.search(r"\d+", holes_el.get("data-bs-title", "") or holes_el.get_text(strip=True))
            if m:
                holes = int(m.group(0))

        price_el = card.select_one("p.cust-card-trim") or card.select_one(".bg-secondary")
        price = None
        if price_el:
            m = _PRICE_RE.search(price_el.get_text(strip=True))
            if m:
                price = float(m.group(0).replace(",", ""))

        rows.append({
            "date": d.isoformat(),
            "time": _to_24h(title.get_text(strip=True)),
            "holes": holes,
            "price": price,
            "maxPlayers": players,
            "raw": {"time_text": title.get_text(strip=True), "html": str(card)},
        })
    return rows


def scrape(course, start, days, conn=None, *, persist_session=True):
    cfg = course["config"]
    referer = course["bookingUrl"]
    return collect_days(start, days, lambda d: _parse(_fetch(cfg, d, referer), d))
