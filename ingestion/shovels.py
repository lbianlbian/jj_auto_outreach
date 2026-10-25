"""Find small electrical contractors in Shovels with a usable email, about 10 per run.

Flow: per state, find the newest day with data (free coverage endpoint) -> walk back from
the day before, GET /contractors/search for each day not searched yet -> keep small
contractors with a usable primary_email -> stop at --max-leads.

Credits are billed per contractor returned, so --max-contractors bounds a run's spend.
Each (state, day) is searched at most once; contractors from earlier runs are skipped
via the seen file. See ingestion/README.md.

Usage:
    python -m ingestion.shovels --days 30 --states CA TX --max-leads 10 --out leads.json
"""

import argparse
import json
import logging
import os
import sys

from dotenv import load_dotenv

from ingestion.client import ShovelsClient
from ingestion.filters import MAX_CONTRACTOR_PERMITS
from ingestion.leads import fetch_leads
from ingestion.store import (DEFAULT_BLOCKLIST, DEFAULT_SEARCH_LOG_FILE, DEFAULT_SEEN_FILE, load_blocklist,
                             load_search_log, load_seen, save_search_log, save_seen)

# No AK or HI: JoJoSpring can't ship there (see filters.UNSHIPPABLE_STATES).
US_STATES = [
    "AL", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "ID",
    "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
    "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
    "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
]

log = logging.getLogger(__name__)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=30, help="look back this many days (default 30)")
    parser.add_argument("--states", nargs="+", default=US_STATES, help="2-letter state codes (default: all but AK and HI)")
    parser.add_argument("--max-leads", type=int, default=10, help="stop after this many filtered leads (default 10)")
    parser.add_argument("--max-contractors", type=int, default=50,
                        help="safety cap on contractors fetched (credits spent) per run; 0 for no cap (default 50)")
    parser.add_argument("--max-contractor-permits", type=int, default=MAX_CONTRACTOR_PERMITS,
                        help=f"skip contractors with more lifetime permits than this (default {MAX_CONTRACTOR_PERMITS})")
    parser.add_argument("--blocklist", default=DEFAULT_BLOCKLIST, help="blocklist JSON (default ingestion/blocklist.json)")
    parser.add_argument("--seen-file", default=DEFAULT_SEEN_FILE,
                        help="contractors processed by earlier runs (default ingestion/seen_contractors.json)")
    parser.add_argument("--search-log-file", default=DEFAULT_SEARCH_LOG_FILE,
                        help="days already searched per state (default ingestion/search_log.json)")
    parser.add_argument("--out", default="-", help="output JSON file (default stdout)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stderr)
    load_dotenv()
    api_key = os.environ.get("SHOVELS_API_KEY")
    if not api_key:
        parser.error("SHOVELS_API_KEY is not set")

    client = ShovelsClient(api_key)
    seen = load_seen(args.seen_file)
    search_log = load_search_log(args.search_log_file)
    try:
        leads = fetch_leads(client, args.states, days=args.days,
                            max_leads=args.max_leads, max_contractors=args.max_contractors or None,
                            max_contractor_permits=args.max_contractor_permits,
                            blocklist=load_blocklist(args.blocklist), seen=seen, search_log=search_log)
    finally:
        # Save even on failure so contractors already paid for aren't looked up again.
        save_seen(seen, args.seen_file)
        save_search_log(search_log, args.search_log_file)
    log.info("credits used: %d, remaining: %s", client.credits_used, client.credits_remaining)

    output = json.dumps(leads, indent=2, default=str)
    if args.out == "-":
        print(output)
    else:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(output)


if __name__ == "__main__":
    main()
