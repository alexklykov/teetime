#!/usr/bin/env python3
"""
Chronogolf / Lightspeed (e.g. North Bellingham -- chronogolf.com/club/north-bellingham-golf-course).

Public JSON API, no login:
  GET https://www.chronogolf.com/marketplace/clubs/{clubId}/teetimes
      ?date=YYYY-MM-DD&course_id={courseId}&nb_holes=18
      &affiliation_type_ids[]={affiliationTypeId}   (repeated once per player)

config: { clubId, courseId, affiliationTypeId }
"""

from scrapers.common import collect_days, get

BASE = "https://www.chronogolf.com/marketplace"

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
}


def _fetch(cfg, d, referer):
    params = [
        ("date", d.isoformat()),
        ("course_id", cfg["courseId"]),
        ("nb_holes", 18),
        ("affiliation_type_ids[]", cfg["affiliationTypeId"]),
    ]
    resp = get(
        f"{BASE}/clubs/{cfg['clubId']}/teetimes",
        params=params,
        headers={**HEADERS, "Referer": referer},
    )
    return resp.json()


def _parse(raw, d):
    if not isinstance(raw, list):
        raise ValueError("Expected Chronogolf slot list")
    rows = []
    for slot in raw or []:
        if slot.get("frozen") or slot.get("out_of_capacity"):
            continue  # blocked, or no open spots
        fees = slot.get("green_fees") or [{}]
        cart = fees[0].get("half_cart") or fees[0].get("one_person_cart")
        rows.append({
            "date": d.isoformat(),
            "time": (slot.get("start_time") or "")[:5],
            "holes": 18,  # we request nb_holes=18; slot["hole"] is the tee-off hole #, not the count
            "price": fees[0].get("price"),
            "cartFee": cart,
            "raw": slot,
        })
    return rows


def scrape(course, start, days, conn=None, *, persist_session=True):
    cfg = course["config"]
    referer = course["bookingUrl"]
    return collect_days(start, days, lambda d: _parse(_fetch(cfg, d, referer), d))
