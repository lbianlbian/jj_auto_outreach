"""Turn Shovels contractor searches into filtered leads while spending as few credits as possible.

We only need a steady supply of new leads, not every contractor (see ingestion/README.md),
so each (state, day) is searched at most once and whatever a run doesn't use is abandoned.

Shovels ingests permits in irregular batches, typically ~9 days late, and the newest day
it has is usually still filling in. So for each state a run asks the free coverage
endpoint for the newest day with any permits, treats that day as partial, and walks
backward from the day before, searching days not searched yet until leads are full.
"""

import logging
from collections import Counter
from datetime import date, timedelta

from ingestion.filters import MAX_CONTRACTOR_PERMITS, UNSHIPPABLE_STATES, skip_reason
from ingestion.store import load_blocklist

log = logging.getLogger(__name__)


def _newest_day_with_data(client, state, today, oldest):
    """Newest day in [oldest, today] that Shovels has any permits for, or None.

    Uses the credit-exempt coverage endpoint, so walking day by day costs nothing.
    """
    day = today
    while day >= oldest:
        total = client.permits_total(state, day.isoformat(), day.isoformat())
        if total is None or total > 0:  # None: every field reliable, so there is data
            return day
        day -= timedelta(days=1)
    return None


def fetch_leads(client, states, days=30, max_leads=10, max_contractors=None,
                max_contractor_permits=MAX_CONTRACTOR_PERMITS, blocklist=None, seen=None,
                search_log=None, today=None):
    """Return up to max_leads filtered leads, each one a contractor with a recent electrical permit.

    Every contractor returned is billed, so pages request only the leads still needed and
    fetching stops as soon as max_leads pass the filters. max_contractors caps the
    records paid for in one run. Contractors already in `seen` are skipped (they still
    cost 1 credit each when returned); every contractor fetched is added to `seen`
    (mutated in place) with its outcome. `search_log` (also mutated) records, per state,
    the days already searched within the lookback and when the state was last searched.
    States are visited least-recently-searched first, which spreads leads across states.
    """
    blocklist = blocklist or load_blocklist()
    seen = {} if seen is None else seen
    search_log = {} if search_log is None else search_log
    today = today or date.today()
    oldest = today - timedelta(days=days)
    leads = []
    seen_emails = {entry["email"] for entry in seen.values() if entry.get("email")}
    skipped = Counter()
    fetched = 0

    def search_day(state, day):
        """Take leads from one (state, day) until leads are full or the day runs out."""
        nonlocal fetched
        remaining = max_contractors - fetched if max_contractors else None
        count = 0
        for contractor in client.search_contractors(state, day, day, max_records=remaining,
                                                    page_size=lambda: max_leads - len(leads)):
            fetched += 1
            count += 1
            cid = contractor["id"]
            if cid in seen:
                skipped["seen in earlier run"] += 1
                continue
            reason = skip_reason(contractor, max_contractor_permits, blocklist)
            email = None if reason else contractor["primary_email"].strip().lower()
            if email in seen_emails:
                reason = "duplicate email"
            seen[cid] = {"email": None if reason else email, "status": reason or "lead",
                         "first_seen": today.isoformat()}
            if reason:
                skipped[reason] += 1
                continue
            seen_emails.add(email)
            leads.append({
                "contractor_id": cid,
                "name": contractor.get("business_name") or contractor.get("name"),
                "email": email,
                "phone": contractor.get("primary_phone"),
                "website": contractor.get("website"),
                "state": state,
                "permit_date": day,
                "contractor": contractor,
            })
            if len(leads) >= max_leads:
                break
        log.info("%s %s: %d contractors, %d leads so far", state, day, count, len(leads))

    def out_of_budget():
        return len(leads) >= max_leads or (max_contractors and fetched >= max_contractors)

    if excluded := [s for s in states if s.upper() in UNSHIPPABLE_STATES]:
        log.info("skipping %s: JoJoSpring can't ship there", ", ".join(excluded))
    states = [s for s in states if s.upper() not in UNSHIPPABLE_STATES]
    # Never-searched states first (""), then least recently searched; ties keep given order.
    states = sorted(states, key=lambda s: search_log.get(s, {}).get("last_searched", ""))
    for state in states:
        if out_of_budget():
            break
        entry = search_log.setdefault(state, {})
        # Stamp before searching so a state with no data still rotates to the back.
        entry["last_searched"] = today.isoformat()
        # Days before the lookback are never reached again, so forget them.
        searched = {d for d in entry.get("days", []) if d >= oldest.isoformat()}
        entry["days"] = sorted(searched)
        newest = _newest_day_with_data(client, state, today, oldest)
        if newest is None:
            log.info("%s: no permits in the last %d days", state, days)
            continue
        # The newest day with data is usually still filling in, so start the day before.
        day = newest - timedelta(days=1)
        while day >= oldest and not out_of_budget():
            if day.isoformat() not in searched:
                search_day(state, day.isoformat())
                # Searched once, even if abandoned partway: there are always more days.
                searched.add(day.isoformat())
                entry["days"] = sorted(searched)
            day -= timedelta(days=1)

    if max_contractors and fetched >= max_contractors:
        log.info("reached --max-contractors=%d, stopping", max_contractors)
    log.info("%d contractors fetched, %d leads kept; skipped: %s", fetched, len(leads), dict(skipped))
    return leads
