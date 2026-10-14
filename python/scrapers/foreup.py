#!/usr/bin/env python3
"""
ForeUp (e.g. Shuksan Golf Club -- foreupsoftware.com/index.php/booking/22876/).

Clean unauthenticated JSON API:
  GET https://foreupsoftware.com/index.php/api/booking/times
      ?time=all&date=MM-DD-YYYY&holes=all&players=0
      &booking_class={bookingClass}&schedule_id={scheduleId}&schedule_ids[]={scheduleId}
      &specials_only=0&api_key=

config: { courseId, bookingClass, scheduleId }
"""

import requests

from scrapers.common import collect_days, get

ENDPOINT = "https://foreupsoftware.com/index.php/api/booking/times"
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "X-Requested-With": "XMLHttpRequest",
}


def _fetch(session, cfg, d, referer):
    params = [
        ("time", "all"),
        ("date", d.strftime("%m-%d-%Y")),
        ("holes", "all"),
        ("players", 0),
        ("booking_class", cfg["bookingClass"]),
        ("schedule_id", cfg["scheduleId"]),
        ("schedule_ids[]", cfg["scheduleId"]),
        ("specials_only", 0),
        ("api_key", ""),
    ]
    resp = get(
        ENDPOINT, session=session, params=params,
        headers={**HEADERS, "Referer": referer},
    )
    return resp.json()


def _parse(raw, d):
    if not isinstance(raw, list):
        raise ValueError("Expected ForeUp slot list")
    rows = []
    for slot in raw or []:
        t = slot.get("time", "")
        # `holes` can be "9", "18", or "9/18" (bookable either way) -- fall back
        # to the tee sheet's own hole count for the ambiguous case.
        holes = slot.get("holes")
        if not (isinstance(holes, int) or (isinstance(holes, str) and holes.isdigit())):
            holes = slot.get("teesheet_holes")
        rate_holes = "9" if str(holes) == "9" else "18"
        price = slot.get(f"green_fee_{rate_holes}")
        if price is None:
            price = slot.get("green_fee")
        rows.append({
            "date": t.split(" ")[0] or d.isoformat(),
            "time": t.split(" ")[-1][:5] if t else None,
            "holes": holes,
            "price": price,
            "price9": slot.get("green_fee_9"),
            "cartFee": slot.get(f"cart_fee_{rate_holes}"),
            "availableSpots": slot.get("available_spots"),
            "rateName": slot.get("rackRateName") or slot.get("rate_name"),
            "raw": slot,
        })
    return rows


def scrape(course, start, days, conn=None, *, persist_session=True):
    cfg = course["config"]
    referer = f"https://foreupsoftware.com/index.php/booking/{cfg['courseId']}/"
    # A bare request only sees tee times a few hours out; loading the booking
    # page first sets PHPSESSID, which unlocks near-term same-day slots.
    with requests.Session() as session:
        # A failed prime can hide same-day availability, so fail this course.
        get(referer, session=session, headers=HEADERS)
        return collect_days(start, days, lambda d: _parse(_fetch(session, cfg, d, referer), d))
