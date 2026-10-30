"""Tests for the pytrends service. A fake TrendReq stands in for pytrends: no request ever reaches Google.

Run: services/pytrends/.venv/Scripts/python -m unittest discover -s services/pytrends   (npm run trends:test)
"""

import json
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import app  # noqa: E402
import pytrends.request  # noqa: E402


class FakeResponse:
    def __init__(self, status_code):
        self.status_code = status_code


class TooManyRequestsError(Exception):
    def __init__(self):
        super().__init__("The request failed: Google returned a response with code 429")
        self.response = FakeResponse(429)


class FakeTrendReq:
    """Records calls; behaviour is set per test through class attributes."""

    calls = []
    fail_with = None
    topics_empty = False

    def __init__(self, **kwargs):
        FakeTrendReq.calls.append(("init", kwargs))

    def build_payload(self, keywords, cat=0, timeframe="", geo=""):
        FakeTrendReq.calls.append(("build_payload", keywords, cat, timeframe, geo))
        self.keywords = keywords
        if FakeTrendReq.fail_with:
            raise FakeTrendReq.fail_with()

    def interest_over_time(self):
        index = pd.to_datetime(["2026-07-20", "2026-07-27"])
        data = {k: [50 + i, 100] for i, k in enumerate(self.keywords)}
        data["isPartial"] = [False, True]
        return pd.DataFrame(data, index=index)

    def interest_by_region(self, resolution="REGION", inc_low_vol=True, inc_geo_code=True):
        df = pd.DataFrame({k: [90, 10] for k in self.keywords}, index=["Kerala", "Gujarat"])
        df.insert(0, "geoCode", ["IN-KL", "IN-GJ"])
        return df

    def related_queries(self):
        top = pd.DataFrame({"query": [f"{self.keywords[0]} card"], "value": [100]})
        rising = pd.DataFrame({"query": [f"{self.keywords[0]} video"], "value": [22250]})
        return {self.keywords[0]: {"top": top, "rising": rising}}

    def related_topics(self):
        if FakeTrendReq.topics_empty:
            raise IndexError("list index out of range")
        top = pd.DataFrame({"topic_title": ["Wedding"], "topic_type": ["Topic"], "value": [100]})
        return {self.keywords[0]: {"top": top, "rising": None}}


BODY = {"keywords": ["wedding invitation"], "geo": "IN", "timeframe": "today 3-m", "category": 293}


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.original = pytrends.request.TrendReq
        pytrends.request.TrendReq = FakeTrendReq
        FakeTrendReq.calls = []
        FakeTrendReq.fail_with = None
        FakeTrendReq.topics_empty = False
        app.MIN_INTERVAL_SECONDS = 0
        app._cache.clear()
        app._clients.clear()
        app._state.update(last_request=0.0, cooldown_until=0.0, robots_ok=True, robots_checked=time.time(), last_error=None)

    def tearDown(self):
        pytrends.request.TrendReq = self.original

    def test_validation(self):
        with self.assertRaises(app.ServiceError) as err:
            app.validate({**BODY, "keywords": ["a", "b", "c", "d", "e", "f"]})
        self.assertEqual(err.exception.code, "INVALID_REQUEST")
        for bad in ({"geo": "india"}, {"timeframe": "all"}, {"category": "293"}, {"kinds": ["scrape"]}, {"hl": "english"}):
            with self.assertRaises(app.ServiceError):
                app.validate({**BODY, **bad})
        self.assertEqual(app.validate({**BODY, "geo": "IN-GJ"})["geo"], "IN-GJ")

    def test_interest_over_time_and_cache(self):
        first = app.interest_over_time(app.validate(BODY))
        self.assertEqual(first["points"][0], {"date": "2026-07-20", "values": {"wedding invitation": 50.0}, "isPartial": False})
        self.assertTrue(first["points"][1]["isPartial"])
        self.assertFalse(first["cached"])
        second = app.interest_over_time(app.validate(BODY))
        self.assertTrue(second["cached"])
        self.assertEqual(len([c for c in FakeTrendReq.calls if c[0] == "build_payload"]), 1)
        # No retries and no backoff inside pytrends: the service decides what happens after an error.
        self.assertEqual(FakeTrendReq.calls[0][1]["retries"], 0)

    def test_rate_limit_starts_a_cool_down_without_further_requests(self):
        FakeTrendReq.fail_with = TooManyRequestsError
        with self.assertRaises(app.ServiceError) as err:
            app.interest_over_time(app.validate(BODY))
        self.assertEqual((err.exception.status, err.exception.code), (429, "RATE_LIMITED"))
        FakeTrendReq.fail_with = None
        calls = len(FakeTrendReq.calls)
        with self.assertRaises(app.ServiceError) as again:
            app.interest_over_time(app.validate({**BODY, "category": 0}))
        self.assertEqual(again.exception.code, "RATE_LIMITED")
        self.assertGreater(again.exception.retry_after, 0)
        self.assertEqual(len(FakeTrendReq.calls), calls)

    def test_refuses_when_robots_txt_disallows(self):
        app._state.update(robots_ok=False, robots_checked=time.time())
        with self.assertRaises(app.ServiceError) as err:
            app.interest_over_time(app.validate(BODY))
        self.assertEqual(err.exception.code, "DISALLOWED")
        self.assertEqual(FakeTrendReq.calls, [])

    def test_regions_and_related(self):
        regions = app.interest_by_region(app.validate({**BODY, "keywords": ["a b", "c d"]}))
        self.assertEqual(regions["regions"][0], {"name": "Kerala", "geoCode": "IN-KL", "values": {"a b": 90.0, "c d": 90.0}})
        self.assertTrue(regions["limitations"])
        related = app.related(app.validate({**BODY, "keyword": "wedding invitation"}, single_keyword=True))
        self.assertEqual(related["queries"]["rising"], [{"label": "wedding invitation video", "growth": "Breakout"}])
        self.assertEqual(related["topics"]["top"], [{"label": "Wedding", "value": 100.0, "topicType": "Topic"}])

    def test_empty_topics_are_reported_not_invented(self):
        FakeTrendReq.topics_empty = True
        related = app.related(app.validate({**BODY, "keyword": "wedding invitation"}, single_keyword=True))
        self.assertEqual(related["topics"], {"top": [], "rising": []})
        self.assertIn("Google Trends returned no related topics for this search.", related["limitations"])

    def test_only_requested_kinds_are_fetched(self):
        related = app.related(app.validate({**BODY, "keyword": "x y", "kinds": ["queries"]}, single_keyword=True))
        self.assertEqual(related["topics"], {"top": [], "rising": []})


class HttpTest(unittest.TestCase):
    def test_token_is_required(self):
        app.TOKEN = "secret"
        server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_address[1]}/health"
        try:
            with self.assertRaises(urllib.error.HTTPError) as err:
                urllib.request.urlopen(url, timeout=5)
            self.assertEqual(err.exception.code, 401)
            ok = urllib.request.urlopen(urllib.request.Request(url, headers={"x-service-token": "secret"}), timeout=5)
            self.assertTrue(json.loads(ok.read())["pytrendsInstalled"])
        finally:
            server.shutdown()
            server.server_close()
            app.TOKEN = ""


if __name__ == "__main__":
    unittest.main()
