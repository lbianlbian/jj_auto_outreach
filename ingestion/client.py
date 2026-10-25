"""Thin client for the Shovels v2 API, tracking credits spent.

Credits are billed per record returned, not per request; see ingestion/README.md.
"""

import logging
import time

import requests

BASE_URL = "https://api.shovels.ai/v2"
# Upper bound on page size; fetch_leads shrinks pages further to what it still needs.
PAGE_SIZE = 25
MAX_RETRIES = 5

log = logging.getLogger(__name__)


class ShovelsClient:
    def __init__(self, api_key, base_url=BASE_URL, timeout=30):
        self.base_url = base_url
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"X-API-Key": api_key, "Accept": "application/json"})
        self.credits_remaining = None
        self.credits_used = 0

    def _get(self, path, params):
        """GET with retry/backoff on 429 and 5xx."""
        for attempt in range(MAX_RETRIES):
            resp = self.session.get(f"{self.base_url}{path}", params=params, timeout=self.timeout)
            if resp.status_code == 429 or resp.status_code >= 500:
                wait = float(resp.headers.get("Retry-After", 2 ** attempt))
                log.warning("HTTP %s on %s, retrying in %.0fs", resp.status_code, path, wait)
                time.sleep(wait)
                continue
            resp.raise_for_status()
            # Responses that return no records carry no credit headers.
            self.credits_used += int(resp.headers.get("X-Credits-Request", 0))
            if "X-Credits-Remaining" in resp.headers:
                self.credits_remaining = int(resp.headers["X-Credits-Remaining"])
            return resp.json()
        resp.raise_for_status()

    def search_contractors(self, geo_id, permit_from, permit_to, tags=("electrical",),
                           classifications=("electrical",), max_records=None, page_size=lambda: PAGE_SIZE):
        """Yield contractors with a matching permit filed in the window, following next_cursor.

        Results are sorted by contractor id, and each contractor appears once however many
        permits it filed. page_size is called before each request, so the caller can
        shrink pages as it needs fewer records.
        """
        params = {
            "geo_id": geo_id,
            "permit_from": permit_from,
            "permit_to": permit_to,
            "permit_tags": list(tags),
            # The API silently ignores unknown params, so this name must stay exact.
            "contractor_classification_derived": list(classifications),
        }
        fetched = 0
        while True:
            # Shrink the last page so we aren't billed for records past max_records.
            size = min(page_size(), PAGE_SIZE)
            params["size"] = min(size, max_records - fetched) if max_records else size
            body = self._get("/contractors/search", params)
            for contractor in body.get("items", []):
                yield contractor
                fetched += 1
                if max_records and fetched >= max_records:
                    return
            cursor = body.get("next_cursor")
            if not cursor:
                return
            params["cursor"] = cursor

    def permits_total(self, geo_id, date_from, date_to, geo_type="state"):
        """Count of all permits (any type) in the window, from the credit-exempt coverage endpoint.

        Returns None when every tracked field is reliably filled, since the endpoint then
        returns no items to carry the count.
        """
        body = self._get("/meta/coverage", {"geo_id": geo_id, "geo_type": geo_type,
                                            "date_from": date_from, "date_to": date_to})
        items = body.get("items", [])
        return items[0]["permits_total"] if items else None
