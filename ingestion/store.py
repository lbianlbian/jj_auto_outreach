"""Persistent ingestion state: blocklist, seen contractors and per-state search log.

Everything is JSON files for now. These load_*/save_* functions are the only code that
touches storage, so moving to Postgres later means changing only this module.
"""

import json
from pathlib import Path

from ingestion.filters import Blocklist

INGESTION_DIR = Path(__file__).parent
DEFAULT_BLOCKLIST = INGESTION_DIR / "blocklist.json"
DEFAULT_SEEN_FILE = INGESTION_DIR / "seen_contractors.json"
DEFAULT_SEARCH_LOG_FILE = INGESTION_DIR / "search_log.json"


def _load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def _save_json(data, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def load_blocklist(path=DEFAULT_BLOCKLIST):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return Blocklist(data.get("companies", []), data.get("email_domains", []))


def load_seen(path=DEFAULT_SEEN_FILE):
    """Return {contractor_id: {"email", "status", "first_seen"}} from earlier runs."""
    return _load_json(path)


def save_seen(seen, path=DEFAULT_SEEN_FILE):
    _save_json(seen, path)


def load_search_log(path=DEFAULT_SEARCH_LOG_FILE):
    """Return {state: {"days": [searched days], "last_searched"}} from earlier runs."""
    return _load_json(path)


def save_search_log(search_log, path=DEFAULT_SEARCH_LOG_FILE):
    _save_json(search_log, path)
