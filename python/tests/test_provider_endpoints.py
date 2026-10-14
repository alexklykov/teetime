import sys
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scrapers import teesnap


class TeesnapEndpointTests(unittest.TestCase):
    def test_uses_current_public_api_host_and_path(self):
        response = MagicMock()
        response.json.return_value = {"teeTimes": {"teeTimes": [], "bookings": []}}
        with patch("scrapers.teesnap.get", return_value=response) as get:
            payload = teesnap._fetch_day("https://golfloomis.teesnap.net", 789,
                                        date(2026, 10, 14))
        self.assertEqual(get.call_args.args[0],
                         "https://golfloomis.api.teesnap.net/api/bookingsite/teetimes-day")
        self.assertEqual(get.call_args.kwargs["params"]["date"], "2026-10-14")
        self.assertEqual(teesnap._parse_day(payload, date(2026, 10, 14)), [])


if __name__ == "__main__":
    unittest.main()
