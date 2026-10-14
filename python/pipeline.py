#!/usr/bin/env python3
"""
pipeline.py
-----------
The database layer shared by every platform scraper. Nothing here scrapes --
it loads the course list, replaces successful daily tee-time snapshots in Neon, and
reads/writes the saved login session for platforms that need one (CPS).

Connection: DATABASE_URL_UNPOOLED (the direct, non-pooled Neon URL -- this is a
batch writer, not request/response traffic).

A "normalized row" is a plain dict any scraper's scrape() returns. Recognized
keys (all optional except date + time):

    date            "2026-08-30"   (course-local, required)
    time            "14:30"        (24h, course-local, required)
    holes           18             (coalesced to 18 when missing/unknown)
    price           green fee per player, headline/18h rate
    price9          9-hole rate when listed separately
    cartFee
    availableSpots
    minPlayers
    maxPlayers
    rateName
    raw             original parsed row for debugging (defaults to the row itself)
"""

import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


def _load_dotenv():
    """Populate os.environ from repo-root .env.local (no override of real env vars)."""
    env_file = Path(__file__).resolve().parent.parent / ".env.local"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()

# Row keys that map 1:1 to a "TeeTime" column (camelCase, quoted in SQL).
_COLS = [
    "date", "time", "holes", "price", "price9", "cartFee", "availableSpots",
    "minPlayers", "maxPlayers", "rateName",
]

_UPSERT = """
INSERT INTO "TeeTime"
  ("courseId","date","time","holes","price","price9","cartFee",
   "availableSpots","minPlayers","maxPlayers","rateName","raw","scrapedAt")
VALUES
  (%(courseId)s,%(date)s,%(time)s,%(holes)s,%(price)s,%(price9)s,%(cartFee)s,
   %(availableSpots)s,%(minPlayers)s,%(maxPlayers)s,%(rateName)s,%(raw)s, now() AT TIME ZONE 'UTC')
ON CONFLICT ("courseId","date","time","holes") DO UPDATE SET
  "price"          = EXCLUDED."price",
  "price9"         = EXCLUDED."price9",
  "cartFee"        = EXCLUDED."cartFee",
  "availableSpots" = EXCLUDED."availableSpots",
  "minPlayers"     = EXCLUDED."minPlayers",
  "maxPlayers"     = EXCLUDED."maxPlayers",
  "rateName"       = EXCLUDED."rateName",
  "raw"            = EXCLUDED."raw",
  "scrapedAt"      = now() AT TIME ZONE 'UTC'
"""


def connect(read_only=False):
    url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("Set DATABASE_URL_UNPOOLED (the direct Neon connection string).")
    conn = psycopg.connect(url, row_factory=dict_row, autocommit=True)
    if read_only:
        conn.execute("SET default_transaction_read_only = on")
    return conn


def load_courses(conn, only=None):
    """Active courses, optionally filtered to one slug. `config` comes back parsed."""
    sql = 'SELECT id, slug, name, platform, "bookingUrl", config FROM "Course" WHERE active'
    params = []
    if only:
        sql += " AND slug = %s"
        params.append(only)
    sql += " ORDER BY name"
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


_MONEY = {"price", "price9", "cartFee"}
_INT = {"availableSpots", "minPlayers", "maxPlayers"}


def _num(v):
    if v is None or isinstance(v, (int, float)):
        return v
    try:
        return float(str(v).replace("$", "").replace(",", "").strip())
    except ValueError:
        return None


def _params(course_id, r):
    p = {}
    for k in _COLS:
        v = r.get(k)
        if k in _MONEY:
            v = _num(v)
        elif k in _INT and v is not None:
            try:
                v = int(v)
            except (TypeError, ValueError):
                v = None
        p[k] = v
    # holes: the unique key needs a concrete int; "9/18"-style values -> 18.
    try:
        p["holes"] = int(r.get("holes"))
    except (TypeError, ValueError):
        p["holes"] = 18
    p["courseId"] = course_id
    p["raw"] = Jsonb(r.get("raw", r))
    return p


def replace_day(conn, course_id, day, rows):
    """Atomically replace a complete day, including confirmed empty availability."""
    if any(row.get("date") != day for row in rows):
        raise ValueError("Snapshot contains a different date")
    params = [_params(course_id, row) for row in rows]
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute('DELETE FROM "TeeTime" WHERE "courseId" = %s AND date = %s',
                        [course_id, day])
            if params:
                cur.executemany(_UPSERT, params)
            cur.execute(
                'INSERT INTO "ScrapeStatus" '
                '("courseId", date, "attemptedAt", "succeededAt", error) '
                "VALUES (%s, %s, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC', NULL) "
                'ON CONFLICT ("courseId", date) DO UPDATE SET '
                '"attemptedAt" = EXCLUDED."attemptedAt", '
                '"succeededAt" = EXCLUDED."succeededAt", error = NULL',
                [course_id, day],
            )
    return len(params)


def record_failure(conn, course_id, day, error):
    """Preserve the last successful snapshot and timestamp after a failed fetch."""
    with conn.cursor() as cur:
        cur.execute(
            'INSERT INTO "ScrapeStatus" ("courseId", date, "attemptedAt", error) '
            "VALUES (%s, %s, now() AT TIME ZONE 'UTC', %s) "
            'ON CONFLICT ("courseId", date) DO UPDATE SET '
            '"attemptedAt" = EXCLUDED."attemptedAt", error = EXCLUDED.error',
            [course_id, day, error],
        )


def prune_past_days(conn, today):
    """This is a live availability database; retain only current/future dates."""
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute('DELETE FROM "TeeTime" WHERE date < %s', [today])
            cur.execute('DELETE FROM "ScrapeStatus" WHERE date < %s', [today])


def get_session(conn, course_id):
    """The saved Playwright storage_state dict for a course, or None."""
    with conn.cursor() as cur:
        cur.execute(
            'SELECT "storageState" FROM "CourseSession" WHERE "courseId" = %s',
            [course_id],
        )
        row = cur.fetchone()
    return row["storageState"] if row else None


def save_session(conn, course_id, state):
    with conn.cursor() as cur:
        cur.execute(
            'INSERT INTO "CourseSession" ("courseId","storageState","updatedAt") '
            "VALUES (%s, %s, now() AT TIME ZONE 'UTC') "
            'ON CONFLICT ("courseId") DO UPDATE SET '
            '"storageState" = EXCLUDED."storageState", "updatedAt" = EXCLUDED."updatedAt"',
            [course_id, Jsonb(state)],
        )
