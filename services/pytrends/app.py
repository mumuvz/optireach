"""Optional, experimental Google Trends provider built on pytrends (unofficial, archived April 2025).

A small HTTP service the Node backend calls. It is deliberately conservative:
  * binds to 127.0.0.1 and requires a shared token (X-Service-Token);
  * checks trends.google.com/robots.txt before every request and refuses if the endpoints are disallowed;
  * sends at most one request to Google at a time, with a minimum gap between requests;
  * after Google answers 429 (rate limited) it stops calling Google for a cool-down period and says so;
  * never uses proxies, rotating identities or anything else that would get around Google's limits;
  * caches answers in memory for a while to avoid repeating the same request;
  * returns explicit errors and never invents data.

Endpoints (POST, JSON):
  /interest-over-time   {keywords[1..5], geo, timeframe, category}
  /interest-by-region   {keywords[1..5], geo, timeframe, category, resolution: COUNTRY|REGION|CITY}
  /related              {keyword, geo, timeframe, category} -> related queries and topics (top and rising)
GET /health             service, pytrends and robots.txt status
"""

from __future__ import annotations

import json
import os
import re
import socket
import threading
import time
import urllib.robotparser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("PYTRENDS_HOST", "127.0.0.1")
PORT = int(os.environ.get("PYTRENDS_PORT", "4410"))
TOKEN = os.environ.get("PYTRENDS_SERVICE_TOKEN", "")
MIN_INTERVAL_SECONDS = float(os.environ.get("PYTRENDS_MIN_INTERVAL_SECONDS", "8"))
COOLDOWN_SECONDS = float(os.environ.get("PYTRENDS_COOLDOWN_SECONDS", "900"))
CACHE_SECONDS = float(os.environ.get("PYTRENDS_CACHE_SECONDS", "3600"))
TIMEOUT = (10, 30)  # connect, read seconds
MAX_KEYWORDS = 5
TIMEFRAMES = {"now 7-d", "today 1-m", "today 3-m", "today 12-m", "today 5-y"}
GEO = re.compile(r"^([A-Z]{2}(-[A-Z0-9]{1,3})?)?$")
HL = re.compile(r"^[a-z]{2,3}(-[A-Z]{2})?$")
ROBOTS_URL = "https://trends.google.com/robots.txt"
# Paths pytrends requests; every one must be allowed by robots.txt.
GOOGLE_PATHS = [
    "https://trends.google.com/?geo=US",
    "https://trends.google.com/trends/api/explore?hl=en-US",
    "https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US",
    "https://trends.google.com/trends/api/widgetdata/comparedgeo?hl=en-US",
    "https://trends.google.com/trends/api/widgetdata/relatedsearches?hl=en-US",
]

_lock = threading.Lock()
_state = {"last_request": 0.0, "cooldown_until": 0.0, "robots_checked": 0.0, "robots_ok": None, "last_error": None}
_cache: dict[str, tuple[float, dict]] = {}
# One pytrends client per language: creating one fetches a Google cookie, so clients are reused, not recreated.
_clients: dict[str, object] = {}


class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after


def robots_allowed() -> bool:
    """Reads robots.txt at most once a day; every path pytrends uses must be allowed for all user agents."""
    now = time.time()
    if _state["robots_ok"] is None or now - _state["robots_checked"] > 86400:
        parser = urllib.robotparser.RobotFileParser(ROBOTS_URL)
        try:
            parser.read()
        except Exception as exc:  # unreachable robots.txt: assume disallowed (RFC 9309)
            _state.update(robots_ok=False, robots_checked=now)
            raise ServiceError(503, "ROBOTS_UNREACHABLE", f"trends.google.com/robots.txt could not be read: {exc}") from exc
        _state.update(robots_ok=all(parser.can_fetch("*", url) for url in GOOGLE_PATHS), robots_checked=now)
    return bool(_state["robots_ok"])


def validate(body: dict, single_keyword: bool = False) -> dict:
    keywords = body.get("keywords") if not single_keyword else [body.get("keyword")]
    if not isinstance(keywords, list) or not keywords or len(keywords) > MAX_KEYWORDS:
        raise ServiceError(400, "INVALID_REQUEST", f"Send 1 to {MAX_KEYWORDS} keywords.")
    clean = []
    for k in keywords:
        if not isinstance(k, str) or not (1 <= len(k.strip()) <= 100):
            raise ServiceError(400, "INVALID_REQUEST", "Each keyword must be 1 to 100 characters.")
        clean.append(k.strip())
    geo = body.get("geo") or ""
    if not isinstance(geo, str) or not GEO.match(geo):
        raise ServiceError(400, "INVALID_REQUEST", "geo must be a country code such as IN or a region such as IN-GJ.")
    timeframe = body.get("timeframe", "today 3-m")
    if timeframe not in TIMEFRAMES:
        raise ServiceError(400, "INVALID_REQUEST", f"timeframe must be one of {sorted(TIMEFRAMES)}.")
    category = body.get("category", 0)
    if not isinstance(category, int) or not (0 <= category <= 100000):
        raise ServiceError(400, "INVALID_REQUEST", "category must be a Google Trends category id (0 for all).")
    resolution = body.get("resolution", "REGION")
    if resolution not in {"COUNTRY", "REGION", "CITY", "DMA"}:
        raise ServiceError(400, "INVALID_REQUEST", "resolution must be COUNTRY, REGION, CITY or DMA.")
    kinds = body.get("kinds", ["queries", "topics"])
    if not isinstance(kinds, list) or not kinds or any(k not in ("queries", "topics") for k in kinds):
        raise ServiceError(400, "INVALID_REQUEST", "kinds must list queries and/or topics.")
    hl = body.get("hl", "en-US")
    if not isinstance(hl, str) or not HL.match(hl):
        raise ServiceError(400, "INVALID_REQUEST", "hl must be a language such as en-US.")
    return {"keywords": clean, "geo": geo, "timeframe": timeframe, "category": category, "resolution": resolution,
            "kinds": sorted(set(kinds)), "hl": hl}


def call_google(cache_key: str, fn, hl: str = "en-US"):
    """Runs one pytrends operation politely: cache, robots.txt, cool-down after 429, one request at a time."""
    cached = _cache.get(cache_key)
    if cached and time.time() - cached[0] < CACHE_SECONDS:
        return {**cached[1], "cached": True}
    with _lock:
        now = time.time()
        if now < _state["cooldown_until"]:
            raise ServiceError(
                429, "RATE_LIMITED", "Google Trends rate-limited earlier requests; waiting before trying again.",
                retry_after=int(_state["cooldown_until"] - now),
            )
        if not robots_allowed():
            raise ServiceError(403, "DISALLOWED", "trends.google.com/robots.txt does not allow these requests.")
        wait = _state["last_request"] + MIN_INTERVAL_SECONDS - now
        if wait > 0:
            time.sleep(wait)
        try:
            from pytrends.exceptions import ResponseError
            from pytrends.request import TrendReq
        except ImportError as exc:
            raise ServiceError(503, "UNAVAILABLE", "pytrends is not installed (run npm run trends:setup).") from exc
        try:
            client = _clients.get(hl)
            if client is None:
                client = _clients[hl] = TrendReq(hl=hl, tz=0, timeout=TIMEOUT, retries=0, backoff_factor=0)
            result = fn(client)
        except Exception as exc:  # noqa: BLE001 - mapped to explicit errors below
            status = getattr(getattr(exc, "response", None), "status_code", None)
            name = type(exc).__name__
            if status == 429 or name == "TooManyRequestsError":
                _state["cooldown_until"] = time.time() + COOLDOWN_SECONDS
                _state["last_error"] = "RATE_LIMITED"
                raise ServiceError(429, "RATE_LIMITED", "Google Trends answered 429 (too many requests).",
                                   retry_after=int(COOLDOWN_SECONDS)) from exc
            if "Timeout" in name or "timed out" in str(exc).lower():
                _state["last_error"] = "TIMEOUT"
                raise ServiceError(504, "TIMEOUT", "Google Trends did not answer in time.") from exc
            _state["last_error"] = "UPSTREAM_ERROR"
            detail = f"HTTP {status}" if status else name
            if isinstance(exc, ResponseError) or status:
                raise ServiceError(502, "UPSTREAM_ERROR", f"Google Trends returned an error ({detail}).") from exc
            raise ServiceError(502, "UPSTREAM_ERROR", f"pytrends failed: {name}: {str(exc)[:200]}") from exc
        finally:
            _state["last_request"] = time.time()
        _state["last_error"] = None
        payload = {**result, "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "cached": False}
        _cache[cache_key] = (time.time(), payload)
        return payload


def interest_over_time(req: dict) -> dict:
    def run(client):
        client.build_payload(req["keywords"], cat=req["category"], timeframe=req["timeframe"], geo=req["geo"])
        df = client.interest_over_time()
        if df is None or df.empty:
            raise ServiceError(404, "NO_DATA", "Google Trends has no data for these terms, place and period.")
        partial = df["isPartial"].tolist() if "isPartial" in df.columns else [False] * len(df)
        return {
            "points": [
                {
                    "date": index.strftime("%Y-%m-%dT%H:%M:%S") if index.hour or index.minute else index.strftime("%Y-%m-%d"),
                    "values": {k: (None if row[k] != row[k] else float(row[k])) for k in req["keywords"] if k in df.columns},
                    "isPartial": bool(partial[i]),
                }
                for i, (index, row) in enumerate(df.iterrows())
            ]
        }

    return call_google(json.dumps(["iot", req], sort_keys=True), run, req["hl"])


def interest_by_region(req: dict) -> dict:
    def run(client):
        client.build_payload(req["keywords"], cat=req["category"], timeframe=req["timeframe"], geo=req["geo"])
        df = client.interest_by_region(resolution=req["resolution"], inc_low_vol=True, inc_geo_code=True)
        if df is None or df.empty:
            raise ServiceError(404, "NO_DATA", "Google Trends has no regional data for these terms, place and period.")
        regions = []
        for name, row in df.iterrows():
            regions.append({
                "name": str(name),
                "geoCode": str(row["geoCode"]) if "geoCode" in df.columns else None,
                "values": {k: (None if row[k] != row[k] else float(row[k])) for k in req["keywords"] if k in df.columns},
            })
        limitations = []
        if len(req["keywords"]) > 1:
            limitations.append(
                "With several terms, each region shows how its searches split between the terms (the shares add up "
                "to 100), so compare terms within a region rather than regions with each other."
            )
        return {"resolution": req["resolution"], "regions": regions, "limitations": limitations}

    return call_google(json.dumps(["region", req], sort_keys=True), run, req["hl"])


def _growth(value) -> str:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return str(value)
    return "Breakout" if number >= 5000 else f"+{number}%"


def related(req: dict) -> dict:
    keyword = req["keywords"][0]

    def run(client):
        client.build_payload([keyword], cat=req["category"], timeframe=req["timeframe"], geo=req["geo"])
        limitations = []

        def fetch(method, what):
            time.sleep(min(MIN_INTERVAL_SECONDS, 3))
            try:
                return (method() or {}).get(keyword) or {}
            except IndexError:
                # pytrends 4.9.2 indexes rankedList[0] without checking; Google sends an empty list when it has none.
                limitations.append(f"Google Trends returned no related {what} for this search.")
                return {}

        queries = fetch(client.related_queries, "queries") if "queries" in req["kinds"] else {}
        topics = fetch(client.related_topics, "topics") if "topics" in req["kinds"] else {}

        def rows(df, label, value_key, rising):
            if df is None or getattr(df, "empty", True):
                return []
            out = []
            for _, row in df.head(25).iterrows():
                item = {"label": str(row[label])}
                if rising:
                    formatted = row.get("formattedValue") if hasattr(row, "get") else None
                    item["growth"] = str(formatted) if formatted and formatted == formatted else _growth(row[value_key])
                else:
                    item["value"] = float(row[value_key])
                if "topic_type" in row:
                    item["topicType"] = str(row["topic_type"])
                out.append(item)
            return out

        return {
            "keyword": keyword,
            "queries": {"top": rows(queries.get("top"), "query", "value", False), "rising": rows(queries.get("rising"), "query", "value", True)},
            "topics": {"top": rows(topics.get("top"), "topic_title", "value", False), "rising": rows(topics.get("rising"), "topic_title", "value", True)},
            "limitations": limitations,
        }

    return call_google(json.dumps(["related", req], sort_keys=True), run, req["hl"])


class Handler(BaseHTTPRequestHandler):
    server_version = "SurfacedTrends/1"

    def _send(self, status: int, payload: dict, headers: dict | None = None):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if TOKEN and self.headers.get("x-service-token") != TOKEN:
            self._send(401, {"error": {"code": "UNAUTHORIZED", "message": "Missing or wrong service token."}})
            return False
        return True

    def do_GET(self):  # noqa: N802
        if not self._authorized():
            return
        if self.path != "/health":
            return self._send(404, {"error": {"code": "NOT_FOUND", "message": "Unknown endpoint."}})
        try:
            import pytrends  # noqa: F401
            installed = True
        except ImportError:
            installed = False
        now = time.time()
        self._send(200, {
            "ok": installed,
            "pytrendsInstalled": installed,
            "robotsAllowed": _state["robots_ok"],
            "coolingDownSeconds": max(0, int(_state["cooldown_until"] - now)),
            "lastError": _state["last_error"],
            "limits": {"maxKeywords": MAX_KEYWORDS, "minIntervalSeconds": MIN_INTERVAL_SECONDS},
        })

    def do_POST(self):  # noqa: N802
        if not self._authorized():
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            if length > 20_000:
                raise ServiceError(413, "INVALID_REQUEST", "Request too large.")
            body = json.loads(self.rfile.read(length) or b"{}")
            if self.path == "/interest-over-time":
                result = interest_over_time(validate(body))
            elif self.path == "/interest-by-region":
                result = interest_by_region(validate(body))
            elif self.path == "/related":
                result = related(validate(body, single_keyword=True))
            else:
                raise ServiceError(404, "NOT_FOUND", "Unknown endpoint.")
            self._send(200, result)
        except ServiceError as err:
            headers = {"retry-after": str(err.retry_after)} if err.retry_after else None
            self._send(err.status, {"error": {"code": err.code, "message": err.message, "retryAfterSeconds": err.retry_after}}, headers)
        except json.JSONDecodeError:
            self._send(400, {"error": {"code": "INVALID_REQUEST", "message": "Body must be JSON."}})

    def log_message(self, fmt, *args):  # keep logs short; never log tokens
        print(f"[pytrends-service] {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")


class ExclusiveServer(ThreadingHTTPServer):
    """Refuses to share its port. On Windows, the default SO_REUSEADDR lets a second copy bind the same port, and
    requests then reach whichever copy Windows picks (possibly an old one with another token)."""

    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


if __name__ == "__main__":
    if HOST not in ("127.0.0.1", "localhost") and not TOKEN:
        raise SystemExit("Set PYTRENDS_SERVICE_TOKEN before binding to a non-local address.")
    try:
        server = ExclusiveServer((HOST, PORT), Handler)
    except OSError as exc:
        raise SystemExit(
            f"Port {PORT} is already in use: another pytrends service (or another program) is running. "
            f"Stop it first, or set another port in PYTRENDS_SERVICE_URL. ({exc})"
        ) from exc
    print(f"[pytrends-service] listening on http://{HOST}:{PORT} (min interval {MIN_INTERVAL_SECONDS}s, cache {CACHE_SECONDS}s)")
    server.serve_forever()
