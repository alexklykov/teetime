"""A successful empty day is different from a failed request."""

import re
import time
from dataclasses import dataclass, field
from datetime import timedelta

import requests


class ProviderError(Exception):
    """A deliberately safe operational message, never a raw provider response."""


@dataclass
class ScrapeResult:
    rows: list[dict] = field(default_factory=list)
    successful_dates: set[str] = field(default_factory=set)
    errors: dict[str, str] = field(default_factory=dict)

    def succeed(self, day, rows):
        date = day.isoformat()
        for row in rows:
            if row.get("date") != date or not re.fullmatch(
                r"(?:[01]\d|2[0-3]):[0-5]\d", row.get("time") or ""
            ):
                raise ValueError("Invalid tee-time date or time")
        self.rows.extend(rows)
        self.successful_dates.add(date)


def error_message(exc):
    # Provider errors can contain request URLs, cookies or login field values.
    # Keep operational errors useful without persisting those secrets in logs/DB.
    if isinstance(exc, ProviderError):
        return str(exc)
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        return f"Provider returned HTTP {exc.response.status_code}"
    if isinstance(exc, requests.Timeout):
        return "Provider request timed out"
    if isinstance(exc, requests.ConnectionError):
        return "Provider connection failed"
    if isinstance(exc, (ValueError, TypeError, KeyError, AttributeError)):
        return "Unexpected provider response format"
    return f"Scrape failed ({type(exc).__name__})"


def get(url, *, session=None, **kwargs):
    """Retry transient HTTP failures twice, with a bounded 1s/2s backoff."""
    client = session or requests
    for attempt in range(3):
        try:
            response = client.get(url, timeout=15, **kwargs)
            response.raise_for_status()
            return response
        except requests.RequestException as exc:
            status = exc.response.status_code if exc.response is not None else None
            retryable = isinstance(exc, (requests.Timeout, requests.ConnectionError))
            retryable = retryable or status in {429, 500, 502, 503, 504}
            if not retryable or attempt == 2:
                raise
            time.sleep(2 ** attempt)


def collect_days(start, days, fetch_and_parse):
    result = ScrapeResult()
    for i in range(days):
        day = start + timedelta(days=i)
        try:
            result.succeed(day, fetch_and_parse(day))
        except Exception as exc:
            result.errors[day.isoformat()] = error_message(exc)
    return result
