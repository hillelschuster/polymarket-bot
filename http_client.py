"""
Resilient HTTP Client & Rate Limiter for Polymarket Enhanced
Provides thread-safe connection pooling, adaptive request pacing,
and automated exponential backoff on HTTP 429 / 5xx responses.
"""

import time
import logging
import threading
import requests
from requests.adapters import HTTPAdapter
from urllib3.util import Retry
from typing import Optional, Dict, Any

logger = logging.getLogger("EnhancedBot.HTTP")

class RateLimitedSession:
    """Thread-safe requests.Session with token-bucket rate limiting and 429 retry."""
    def __init__(self, max_requests_per_second: float = 6.0):
        self.min_interval = 1.0 / max_requests_per_second
        self.last_request_time = 0.0
        self._lock = threading.Lock()

        self.session = requests.Session()
        retry_strategy = Retry(
            total=4,
            backoff_factor=1.5,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
            raise_on_status=False
        )
        adapter = HTTPAdapter(max_retries=retry_strategy, pool_connections=20, pool_maxsize=30)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
        self.session.headers.update({
            "User-Agent": "PolymarketEnhanced/2.0 (Quantitative Dual-Pillar Engine)",
            "Accept": "application/json"
        })

    def _pace(self):
        with self._lock:
            now = time.time()
            elapsed = now - self.last_request_time
            if elapsed < self.min_interval:
                time.sleep(self.min_interval - elapsed)
            self.last_request_time = time.time()

    def get(self, url: str, **kwargs) -> requests.Response:
        self._pace()
        kwargs.setdefault("timeout", 5.0)
        try:
            resp = self.session.get(url, **kwargs)
            if resp.status_code == 429:
                retry_after = float(resp.headers.get("Retry-After", 3.0))
                logger.warning(f"[429 RATE LIMIT] Backing off for {retry_after}s on {url[:50]}...")
                time.sleep(retry_after)
                resp = self.session.get(url, **kwargs)
            return resp
        except Exception as e:
            logger.debug(f"HTTP GET Error on {url[:50]}: {e}")
            raise e

    def post(self, url: str, **kwargs) -> requests.Response:
        self._pace()
        kwargs.setdefault("timeout", 6.0)
        try:
            resp = self.session.post(url, **kwargs)
            if resp.status_code == 429:
                retry_after = float(resp.headers.get("Retry-After", 3.0))
                logger.warning(f"[429 RATE LIMIT] Backing off for {retry_after}s on POST {url[:50]}...")
                time.sleep(retry_after)
                resp = self.session.post(url, **kwargs)
            return resp
        except Exception as e:
            logger.debug(f"HTTP POST Error on {url[:50]}: {e}")
            raise e

# Global singleton session instance
global_http_session = RateLimitedSession(max_requests_per_second=6.0)
