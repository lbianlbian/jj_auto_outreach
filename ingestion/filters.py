"""Decide whether a contractor is a usable lead: shipping, size, blocklist and email checks."""

import re

# Contractors with more lifetime permits than this are national/large firms (e.g. Tesla
# has ~75k), not the small shops we're pitching to.
MAX_CONTRACTOR_PERMITS = 500
JUNK_EMAIL_LOCALPARTS = {"no", "none", "na", "n/a", "noemail", "test", "null"}
# JoJoSpring can't ship to these states, so contractors there are never leads.
UNSHIPPABLE_STATES = {"AK", "HI"}


def _normalize_name(name):
    """Uppercase, '&' -> 'AND', other punctuation dropped, so "AT&T" matches "A T & T"-style variants."""
    name = (name or "").upper().replace("&", " AND ")
    return " ".join(re.sub(r"[^A-Z0-9 ]+", "", name).split())


class Blocklist:
    """Big companies and email domains to never pitch.

    Build one with store.load_blocklist() so the source can later be swapped for a
    database table without touching the filtering code.
    """

    def __init__(self, companies=(), email_domains=()):
        names = sorted({_normalize_name(c) for c in companies if _normalize_name(c)})
        # Whole-word match so "ADT SOLAR" doesn't block "BRADT SOLAR".
        self._names = re.compile(r"\b(" + "|".join(map(re.escape, names)) + r")\b") if names else None
        self.email_domains = {d.strip().lower() for d in email_domains}

    def blocks_company(self, contractor):
        if not self._names:
            return False
        return any(self._names.search(_normalize_name(contractor.get(field)))
                   for field in ("business_name", "name", "dba"))


def skip_reason(contractor, max_contractor_permits, blocklist):
    """Return why this contractor isn't a usable lead, or None if it is."""
    # Permits are searched per state, but the contractor's own address is where we'd ship.
    if ((contractor.get("address") or {}).get("state") or "").upper() in UNSHIPPABLE_STATES:
        return "unshippable state"
    if (contractor.get("permit_count") or 0) > max_contractor_permits:
        return "too large"
    if blocklist.blocks_company(contractor):
        return "blocklisted company"
    local, _, domain = (contractor.get("primary_email") or "").strip().lower().partition("@")
    if not local or "." not in domain:
        return "no primary email"
    # .gov addresses are permit offices and other agencies, not contractors.
    if domain in blocklist.email_domains or domain.endswith(".gov") or local in JUNK_EMAIL_LOCALPARTS:
        return "blocked email"
    return None
