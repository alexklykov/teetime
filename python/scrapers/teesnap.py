#!/usr/bin/env python3
"""
Teesnap (e.g. Loomis Trail -- https://golfloomis.teesnap.net/).

Public JSON API used by the booking site's current application, no login:
  GET https://{course}.api.teesnap.net/api/bookingsite/teetimes-day
      ?course={courseId}&date=YYYY-MM-DD&players=0&holes=18&addons=off

The `players`/`holes` params don't filter, so availability is computed from the
response itself: 4 (a foursome) minus golfers already booked into the slot, or 0
if the slot is held.  config: { courseId }  (base host is the course bookingUrl).
"""

from urllib.parse import urlsplit

from scrapers.common import collect_days, get

MAX_CAPACITY = 4

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
}


def _base(course):
    p = urlsplit(course["bookingUrl"])
    return f"{p.scheme}://{p.netloc}"


def _fetch_day(base, course_id, d):
    api_base = base.replace(".teesnap.net", ".api.teesnap.net")
    resp = get(
        f"{api_base}/api/bookingsite/teetimes-day",
        params={"course": course_id, "date": d.isoformat(),
                "players": 0, "holes": 18, "addons": "off"},
        headers={**HEADERS, "Referer": f"{base}/"},
    )
    return resp.json()


def _parse_day(data, d):
    if not isinstance(data, dict) or not isinstance(data.get("teeTimes"), dict):
        raise ValueError("Missing Teesnap tee-time response")
    root = data["teeTimes"]
    slots = root.get("teeTimes")
    if not isinstance(slots, list):
        raise ValueError("Missing Teesnap slots")
    bookings = root.get("bookings") or []
    golfers_by_booking = {
        b.get("bookingId"): len(b.get("golfers") or []) for b in bookings
    }

    rows = []
    for slot in slots:
        sections = slot.get("teeOffSections") or []
        is_held = any(s.get("isHeld") for s in sections)
        if any(bid not in golfers_by_booking for section in sections
               for bid in (section.get("bookings") or [])):
            raise ValueError("Teesnap booking details are incomplete")
        occupied = sum(
            golfers_by_booking.get(bid, 0)
            for s in sections
            for bid in (s.get("bookings") or [])
        )
        available = 0 if is_held else max(MAX_CAPACITY - occupied, 0)
        prices = {p.get("roundType"): p.get("price") for p in (slot.get("prices") or [])}
        t = (slot.get("teeTime") or "").replace("T", " ")

        rows.append({
            "date": d.isoformat(),
            "time": t.split(" ")[-1][:5] if t else None,
            "holes": 18,
            "price": prices.get("EIGHTEEN_HOLE"),
            "price9": prices.get("NINE_HOLE"),
            "availableSpots": available,
            "maxPlayers": MAX_CAPACITY,
            "rateName": slot.get("rackRateName"),
            "raw": {"occupied": occupied, "is_held": is_held, "slot": slot},
        })
    return rows


def scrape(course, start, days, conn=None, *, persist_session=True):
    base = _base(course)
    course_id = course["config"]["courseId"]
    return collect_days(start, days, lambda d: _parse_day(_fetch_day(base, course_id, d), d))
