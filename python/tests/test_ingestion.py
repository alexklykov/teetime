import contextlib
import io
import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ingest
import pipeline
from scrapers import chronogolf, cps, foreup, golfrev, teesnap
from scrapers.common import ProviderError, ScrapeResult, collect_days, get
import requests


DAY = date(2026, 10, 14)
TODAY = DAY.isoformat()
TOMORROW = "2026-10-15"


class DailyResultsTests(unittest.TestCase):
    def test_successful_empty_day_is_distinct_from_failed_day(self):
        fetch = MagicMock(side_effect=[[], requests.Timeout("private request info")])
        result = collect_days(DAY, 2, fetch)
        self.assertEqual(result.successful_dates, {TODAY})
        self.assertEqual(result.errors, {TOMORROW: "Provider request timed out"})
        self.assertEqual(result.rows, [])

    def test_invalid_slot_does_not_make_a_destructive_empty_snapshot(self):
        result = collect_days(DAY, 1, lambda day: [{"date": TODAY, "time": "25:00"}])
        self.assertFalse(result.successful_dates)
        self.assertIn(TODAY, result.errors)

    def test_api_error_payloads_are_not_empty_availability(self):
        for parser in [chronogolf._parse, foreup._parse, teesnap._parse_day]:
            with self.subTest(parser=parser.__module__):
                with self.assertRaises(ValueError):
                    parser({"error": "unavailable"}, DAY)
        with self.assertRaises(ValueError):
            golfrev._parse("<html>Verify you are human</html>", DAY)
        with self.assertRaises(ValueError):
            cps._parse_items(None, DAY)

    def test_confirmed_empty_provider_responses(self):
        self.assertEqual(chronogolf._parse([], DAY), [])
        self.assertEqual(foreup._parse([], DAY), [])
        self.assertEqual(teesnap._parse_day({"teeTimes": {"teeTimes": []}}, DAY), [])
        self.assertEqual(golfrev._parse("<p>No tee times available</p>", DAY), [])
        self.assertEqual(cps._parse_items({}, DAY), [])

    def test_foreup_prices_match_hole_count_and_preserve_free_rates(self):
        row = foreup._parse([{"time": f"{TODAY} 08:00", "holes": "9",
                              "green_fee_9": 0, "green_fee_18": 60, "green_fee": 50,
                              "cart_fee_9": 0, "cart_fee_18": 20}], DAY)[0]
        self.assertEqual(row["price"], 0)
        self.assertEqual(row["cartFee"], 0)

    def test_cps_rejects_another_day_and_normalizes_utc_times(self):
        with self.assertRaises(ValueError):
            cps._parse_items([{"startTime": f"{TOMORROW}T08:00:00"}], DAY)
        row = cps._parse_items([{"startTime": f"{TOMORROW}T00:00:00Z"}], DAY)[0]
        self.assertEqual(row["time"], "17:00")
        self.assertEqual(row["date"], TODAY)

    def test_missing_teesnap_booking_details_does_not_invent_open_spots(self):
        data = {"teeTimes": {"teeTimes": [{"teeTime": f"{TODAY}T08:00:00",
                    "teeOffSections": [{"bookings": [123]}]}], "bookings": []}}
        with self.assertRaises(ValueError):
            teesnap._parse_day(data, DAY)

    def test_request_retries_transient_errors_but_not_forbidden(self):
        client = MagicMock()
        response = MagicMock()
        client.get.side_effect = [requests.Timeout(), requests.ConnectionError(), response]
        with patch("scrapers.common.time.sleep") as sleep:
            self.assertIs(get("https://example.invalid", session=client), response)
        self.assertEqual(client.get.call_count, 3)
        self.assertEqual(sleep.call_args_list, [call(1), call(2)])

        forbidden = requests.Response()
        forbidden.status_code = 403
        client.get.reset_mock()
        client.get.side_effect = requests.HTTPError(response=forbidden)
        with patch("scrapers.common.time.sleep") as sleep:
            with self.assertRaises(requests.HTTPError):
                get("https://example.invalid", session=client)
        client.get.assert_called_once()
        sleep.assert_not_called()

    def test_retry_count_is_bounded(self):
        client = MagicMock()
        client.get.side_effect = requests.Timeout()
        with patch("scrapers.common.time.sleep"):
            with self.assertRaises(requests.Timeout):
                get("https://example.invalid", session=client)
        self.assertEqual(client.get.call_count, 3)

    def test_cps_retries_a_timeout_and_continues_to_the_next_day(self):
        page = MagicMock()
        page.url = "https://example.invalid/search-teetime"
        page.locator.return_value.filter.return_value.count.return_value = 1
        response = page.expect_response.return_value.__enter__.return_value.value
        response.status = 200
        response.json.side_effect = [cps.PWTimeoutError("private details"),
                                     {"content": []}, {"content": []}]
        with patch("scrapers.cps._open_widget", return_value=DAY.replace(day=1)):
            result = cps._read_days(page, "https://example.invalid", DAY, 2)
        self.assertEqual(result.successful_dates, {TODAY, TOMORROW})
        self.assertFalse(result.errors)
        self.assertEqual(response.json.call_count, 3)

    def test_cps_parse_failure_preserves_that_day_but_processes_the_next(self):
        page = MagicMock()
        page.url = "https://example.invalid/search-teetime"
        page.locator.return_value.filter.return_value.count.return_value = 1
        response = page.expect_response.return_value.__enter__.return_value.value
        response.status = 200
        response.json.side_effect = [{"error": "unavailable"}, {"content": []}]
        with patch("scrapers.cps._open_widget", return_value=DAY.replace(day=1)):
            result = cps._read_days(page, "https://example.invalid", DAY, 2)
        self.assertEqual(result.successful_dates, {TOMORROW})
        self.assertEqual(set(result.errors), {TODAY})

    def test_cps_explicitly_disabled_date_is_successful_empty_day(self):
        page = MagicMock()
        page.url = "https://example.invalid/search-teetime"
        page.locator.return_value.filter.return_value.count.side_effect = [0, 1]
        with patch("scrapers.cps._open_widget", return_value=DAY.replace(day=1)):
            result = cps._read_days(page, "https://example.invalid", DAY, 1)
        self.assertEqual(result.successful_dates, {TODAY})
        self.assertEqual(result.rows, [])
        self.assertFalse(result.errors)

    def test_cps_access_restriction_is_reported_without_bypass_attempts(self):
        page = MagicMock()
        page.url = "https://example.invalid/bot-detection"
        with self.assertRaisesRegex(ProviderError, "refuses access"):
            cps._request_teetimes(page, lambda: None)
        page.reload.assert_not_called()

    def test_cps_timeout_diagnostics_do_not_print_url_secrets(self):
        page = MagicMock()
        page.url = "https://example.invalid/search-teetime?token=private-value"
        page.expect_response.return_value.__enter__.side_effect = cps.PWTimeoutError("private-value")
        output = io.StringIO()
        with contextlib.redirect_stderr(output), self.assertRaises(cps.PWTimeoutError):
            cps._request_teetimes(page, lambda: None)
        self.assertIn("request was not started", output.getvalue())
        self.assertNotIn("private-value", output.getvalue())

    def test_cps_document_http_failure_is_visible_and_not_retried(self):
        page = MagicMock()
        page.goto.return_value.status = 403
        with self.assertRaisesRegex(ProviderError, "document returned HTTP 403"):
            cps._navigate(page, "https://example.invalid/search-teetime")
        page.goto.assert_called_once()

    def test_cps_challenge_page_is_detected_without_route_redirect(self):
        page = MagicMock()
        page.url = "https://example.invalid/search-teetime"
        page.title.return_value = "Just a moment..."
        with self.assertRaisesRegex(ProviderError, "refuses access"):
            cps._check_access(page)


class SnapshotTests(unittest.TestCase):
    def test_confirmed_empty_day_deletes_only_that_course_day_and_marks_success(self):
        conn = MagicMock()
        cursor = conn.cursor.return_value.__enter__.return_value
        self.assertEqual(pipeline.replace_day(conn, 7, TODAY, []), 0)
        conn.transaction.assert_called_once()
        delete, status = cursor.execute.call_args_list
        self.assertIn('DELETE FROM "TeeTime"', delete.args[0])
        self.assertEqual(delete.args[1], [7, TODAY])
        self.assertIn('"succeededAt"', status.args[0])
        cursor.executemany.assert_not_called()

    def test_insert_failure_exits_transaction_with_error(self):
        conn = MagicMock()
        cursor = conn.cursor.return_value.__enter__.return_value
        cursor.executemany.side_effect = RuntimeError("insertion failed")
        with self.assertRaises(RuntimeError):
            pipeline.replace_day(conn, 7, TODAY, [{"date": TODAY, "time": "08:00"}])
        transaction = conn.transaction.return_value
        self.assertIs(transaction.__exit__.call_args.args[0], RuntimeError)
        self.assertEqual(cursor.execute.call_count, 1)  # success status never written

    def test_failed_day_preserves_slots_and_last_success(self):
        conn = MagicMock()
        pipeline.record_failure(conn, 7, TODAY, "Provider request timed out")
        cursor = conn.cursor.return_value.__enter__.return_value
        sql = cursor.execute.call_args.args[0]
        self.assertNotIn("DELETE", sql)
        self.assertNotIn('"succeededAt"', sql)
        self.assertIn('"attemptedAt"', sql)


class IngestTests(unittest.TestCase):
    def run_ingest(self, dry_run=False):
        courses = [{"id": 1, "slug": "one", "platform": "test"},
                   {"id": 2, "slug": "two", "platform": "test"}]
        scrape = MagicMock(side_effect=[
            ScrapeResult(successful_dates={TODAY}, errors={TOMORROW: "timeout"}),
            ScrapeResult(successful_dates={TODAY, TOMORROW}),
        ])
        with contextlib.ExitStack() as stack:
            connect = stack.enter_context(patch("ingest.pipeline.connect"))
            stack.enter_context(patch("ingest.pipeline.load_courses", return_value=courses))
            replace = stack.enter_context(patch("ingest.pipeline.replace_day"))
            failure = stack.enter_context(patch("ingest.pipeline.record_failure"))
            prune = stack.enter_context(patch("ingest.pipeline.prune_past_days"))
            stack.enter_context(patch("ingest.course_today", return_value=DAY))
            stack.enter_context(patch("ingest.write_summary"))
            stack.enter_context(patch.dict(ingest.PLATFORMS, {"test": scrape}))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            args = ["--days", "2"] + (["--dry-run"] if dry_run else [])
            result = ingest.main(args)
        return result, connect, scrape, replace, failure, prune

    def test_partial_failure_processes_other_courses_and_returns_failure(self):
        result, connect, scrape, replace, failure, prune = self.run_ingest()
        self.assertEqual(result, 1)
        self.assertEqual(scrape.call_count, 2)
        self.assertEqual(replace.call_args_list, [
            call(connect.return_value, 1, TODAY, []),
            call(connect.return_value, 2, TODAY, []),
            call(connect.return_value, 2, TOMORROW, []),
        ])
        failure.assert_called_once_with(connect.return_value, 1, TOMORROW, "timeout")
        prune.assert_called_once_with(connect.return_value, TODAY)

    def test_dry_run_cannot_write_snapshots_statuses_or_sessions(self):
        result, connect, scrape, replace, failure, prune = self.run_ingest(dry_run=True)
        self.assertEqual(result, 1)
        connect.assert_called_once_with(read_only=True)
        replace.assert_not_called()
        failure.assert_not_called()
        prune.assert_not_called()
        for invocation in scrape.call_args_list:
            self.assertFalse(invocation.kwargs["persist_session"])

    def test_today_uses_pacific_date_even_after_utc_midnight(self):
        instant = datetime(2026, 10, 15, 1, tzinfo=timezone.utc)
        with patch("ingest.datetime") as clock:
            clock.now.side_effect = lambda tz: instant.astimezone(tz)
            self.assertEqual(ingest.course_today(), DAY)

    def test_cps_dry_run_never_persists_session(self):
        course = {"id": 1, "slug": "one", "config": {"login": True},
                  "bookingUrl": "https://example.invalid/search-teetime"}
        with patch("scrapers.cps.sync_playwright") as playwright, \
             patch("scrapers.cps.pipeline.get_session", return_value=None), \
             patch("scrapers.cps.pipeline.save_session") as save, \
             patch("scrapers.cps.is_logged_out", return_value=False), \
             patch("scrapers.cps._read_days", return_value=ScrapeResult()):
            browser = playwright.return_value.__enter__.return_value.chromium.launch.return_value
            browser.new_context.return_value.new_page.return_value.url = course["bookingUrl"]
            browser.new_context.return_value.new_page.return_value.goto.return_value.status = 200
            cps.scrape(course, DAY, 1, MagicMock(), persist_session=False)
        save.assert_not_called()
        browser = playwright.return_value.__enter__.return_value.chromium.launch.return_value
        self.assertEqual(browser.new_context.call_args.kwargs["timezone_id"],
                         "America/Los_Angeles")


if __name__ == "__main__":
    unittest.main()
