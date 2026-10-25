"""Tests for the ingestion package against a fake Shovels API (no network, no credits)."""

from datetime import date

import pytest

from ingestion.client import ShovelsClient
from ingestion.filters import MAX_CONTRACTOR_PERMITS, Blocklist, skip_reason
from ingestion.leads import _newest_day_with_data, fetch_leads
from ingestion.store import load_blocklist

TODAY = date(2026, 10, 21)


def _contractor(i, **overrides):
    return {"id": f"C{i:02}", "business_name": f"Shop {i}", "primary_email": f"x{i}@shop{i}.com",
            "permit_count": 5, "classification_derived": ["electrical"], **overrides}


class FakeShovels:
    """Serves /contractors/search sorted by id with a keyset cursor, and /meta/coverage
    counts. Bills 1 credit per contractor returned, the way the real API does; coverage
    is free."""

    def __init__(self):
        self.contractors = {c["id"]: c for c in [
            _contractor(1),
            _contractor(2, permit_count=74859),
            _contractor(3, primary_email="north@ipermitca.com"),
            _contractor(4, primary_email="no@foo.com"),
            _contractor(5, primary_email="x1@shop1.com"),  # same email as C01
            _contractor(6, business_name="Sunrun Inc"),
            _contractor(31, address={"state": "HI"}),  # works in CA, based in Hawaii
            *[_contractor(i) for i in range(7, 30)],
            _contractor(90, business_name="Cool Air HVAC", classification_derived=["hvac"]),
        ]}
        self.permits = {}  # {geo: {day: [contractor ids]}}
        self.add_permits("CA", "2026-10-12", [20, 21])  # newest day: partial, must be skipped
        self.add_permits("CA", "2026-10-11", [1, 1, 2, 3, 4, 5, 6, 7, 8, 90, 27, 28, 31])
        self.add_permits("CA", "2026-10-10", [1, 9, 10, 11, 12, 13])  # C01 again: seen after run 1
        self.add_permits("CA", "2026-10-09", list(range(14, 20)))
        self.reset()

    def add_permits(self, geo, day, ids):
        self.permits.setdefault(geo, {}).setdefault(day, []).extend(f"C{i:02}" for i in ids)

    def reset(self):
        self.calls = []
        self.returned = []  # contractor ids billed, in order

    @property
    def billed(self):
        return len(self.returned)

    def _in_window(self, geo, start, end):
        return [cid for day, ids in self.permits.get(geo, {}).items() if start <= day <= end for cid in ids]

    def get(self, client, path, params):
        self.calls.append((path, dict(params)))
        if path == "/meta/coverage":
            total = len(self._in_window(params["geo_id"], params["date_from"], params["date_to"]))
            return {"items": [{"field": "fees", "tier": "missing", "permits_total": total}]}
        assert path == "/contractors/search"
        wanted = set(params.get("contractor_classification_derived", []))
        ids = sorted({cid for cid in self._in_window(params["geo_id"], params["permit_from"], params["permit_to"])
                      if wanted <= set(self.contractors[cid]["classification_derived"])})
        ids = [cid for cid in ids if cid > params.get("cursor", "")]
        page = ids[:params["size"]]
        self.returned += page
        return {"items": [self.contractors[cid] for cid in page],
                "next_cursor": page[-1] if len(ids) > len(page) else None}

    def searched(self):
        """(geo, day) of each paid search request, in order."""
        return [(q["geo_id"], q["permit_from"]) for p, q in self.calls if p == "/contractors/search"]


@pytest.fixture
def api(monkeypatch):
    fake = FakeShovels()
    monkeypatch.setattr(ShovelsClient, "_get", lambda self, path, params: fake.get(self, path, params))
    return fake


def fetch(states, max_leads, seen, search_log, **kwargs):
    return fetch_leads(ShovelsClient("test-key"), states, days=30, max_leads=max_leads,
                       blocklist=load_blocklist(), seen=seen, search_log=search_log, today=TODAY, **kwargs)


def names(leads):
    return [lead["name"] for lead in leads]


def test_first_run_filters_and_records_outcomes(api):
    seen, search_log = {}, {}
    leads = fetch(["CA"], 3, seen, search_log)

    assert names(leads) == ["Shop 1", "Shop 7", "Shop 8"]
    assert leads[0]["email"] == "x1@shop1.com"
    assert leads[0]["permit_date"] == "2026-10-11"
    assert {cid: e["status"] for cid, e in seen.items() if e["status"] != "lead"} == {
        "C02": "too large",
        "C03": "blocked email",
        "C04": "blocked email",
        "C05": "duplicate email",
        "C06": "blocklisted company",
    }
    assert "C31" not in seen  # sorts after the 3rd lead, so never fetched
    assert search_log == {"CA": {"last_searched": "2026-10-21", "days": ["2026-10-11"]}}


def test_newest_day_with_data_is_skipped_as_partial(api):
    fetch(["CA"], 3, {}, {})
    assert api.searched()[0] == ("CA", "2026-10-11")
    assert ("CA", "2026-10-12") not in api.searched()


def test_classification_filter_is_sent(api):
    # The real API silently ignores misspelled params, so pin the exact name.
    fetch(["CA"], 10, {}, {})
    assert all(q["contractor_classification_derived"] == ["electrical"]
               for p, q in api.calls if p == "/contractors/search")
    assert "C90" not in api.returned  # the HVAC shop on 10-11 is filtered by the server


def test_no_paid_contractor_goes_unused(api):
    fetch(["CA"], 3, {}, {})
    # C01-C08 are needed to find 3 leads; pages shrink to what's still needed, so no 9th.
    assert api.returned == [f"C{i:02}" for i in range(1, 9)]


def test_each_day_is_searched_only_once(api):
    seen, search_log = {}, {}
    fetch(["CA"], 3, seen, search_log)
    api.reset()

    leads = fetch(["CA"], 3, seen, search_log)

    assert names(leads) == ["Shop 9", "Shop 10", "Shop 11"]
    assert set(api.searched()) == {("CA", "2026-10-10")}  # 10-11 isn't searched again
    assert api.returned == ["C01", "C09", "C10", "C11"]  # C01 is paid for again, then skipped as seen
    assert search_log["CA"]["days"] == ["2026-10-10", "2026-10-11"]


def test_new_batch_moves_the_starting_day(api):
    seen, search_log = {}, {}
    fetch(["CA"], 3, seen, search_log)
    api.add_permits("CA", "2026-10-13", [22, 23])
    api.add_permits("CA", "2026-10-14", [24])  # new newest day, partial
    api.reset()

    leads = fetch(["CA"], 1, seen, search_log)

    assert names(leads) == ["Shop 22"]
    assert api.searched() == [("CA", "2026-10-13")]


def test_walks_back_across_days_until_full(api):
    leads = fetch(["CA"], 12, {}, {})  # 5 leads on 10-11, 5 on 10-10, 2 more needed
    assert list(dict.fromkeys(day for _, day in api.searched())) == ["2026-10-11", "2026-10-10", "2026-10-09"]
    assert len(leads) == 12


def test_stops_before_next_state_once_full(api):
    api.add_permits("TX", "2026-10-11", [25, 26])
    fetch(["CA", "TX"], 3, {}, {})
    assert all(q["geo_id"] == "CA" for _, q in api.calls)


def test_rotation_visits_least_recently_searched_first(api):
    api.add_permits("TX", "2026-10-11", [25])
    api.add_permits("TX", "2026-10-12", [26])
    search_log = {"CA": {"last_searched": "2026-10-20", "days": []}}
    leads = fetch(["CA", "TX"], 1, {}, search_log)
    assert names(leads) == ["Shop 25"]  # never-searched TX beats CA searched yesterday


def test_state_with_no_data_still_rotates_back(api):
    search_log = {}
    fetch(["WY", "CA"], 1, {}, search_log)
    assert search_log["WY"] == {"last_searched": "2026-10-21", "days": []}
    assert not [s for s in api.searched() if s[0] == "WY"]  # no paid calls for WY


def test_contractor_based_in_unshippable_state_is_skipped(api):
    seen = {}
    fetch(["CA"], 10, seen, {})
    assert seen["C31"]["status"] == "unshippable state"


def test_unshippable_states_are_never_searched(api):
    api.add_permits("AK", "2026-10-11", [25])
    api.add_permits("HI", "2026-10-11", [26])
    search_log = {}
    leads = fetch(["AK", "hi", "CA"], 1, {}, search_log)
    assert names(leads) == ["Shop 1"]
    assert {q["geo_id"] for _, q in api.calls} == {"CA"}  # not even a free coverage call
    assert set(search_log) == {"CA"}


def test_max_contractors_caps_spend(api):
    leads = fetch(["CA"], 10, {}, {}, max_contractors=4)
    assert api.billed == 4
    assert names(leads) == ["Shop 1"]


def test_days_before_lookback_are_forgotten(api):
    search_log = {"CA": {"last_searched": "2026-08-01", "days": ["2026-08-01", "2026-10-11"]}}
    fetch(["CA"], 1, {}, search_log)
    assert search_log["CA"]["days"] == ["2026-10-10", "2026-10-11"]


def test_coverage_without_items_counts_as_data():
    class Client:
        def permits_total(self, geo, start, end):
            return None  # every field reliable: no items, so no count

    assert _newest_day_with_data(Client(), "CA", TODAY, date(2026, 9, 21)) == TODAY


@pytest.mark.parametrize("email, reason", [
    ("permits@cityofmesa.gov", "blocked email"),
    ("intake@dot.ca.gov", "blocked email"),
    ("bob@govelectric.com", None),  # "gov" inside a business domain is fine
    ("bob@shop.gov.example.com", None),
])
def test_gov_emails_are_blocked(email, reason):
    contractor = {"primary_email": email, "permit_count": 5}
    assert skip_reason(contractor, MAX_CONTRACTOR_PERMITS, Blocklist()) == reason


@pytest.mark.parametrize("contractor, blocked", [
    ({"business_name": "SUNRUN INSTALLATION SERVICES INC."}, True),
    ({"business_name": "AT&T SERVICES"}, True),
    ({"dba": "A.T. & T"}, True),
    ({"business_name": "LOWES HOME CENTERS"}, True),
    ({"name": "x", "dba": "Tesla Energy"}, True),
    ({"business_name": "BRADT SOLAR"}, False),         # "ADT Solar" must match whole words only
    ({"business_name": "SUNRUNNER ELECTRIC"}, False),  # "Sunrun" must not match inside a word
    ({"business_name": "BETTER ELECTRIC"}, False),
])
def test_blocklist_company_matching(contractor, blocked):
    assert load_blocklist().blocks_company(contractor) is blocked


def test_blocklist_email_domains():
    domains = load_blocklist().email_domains
    assert {"ipermitca.com", "sunrun.com", "tesla.com"} <= domains
