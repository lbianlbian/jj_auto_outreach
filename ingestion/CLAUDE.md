# Ingestion: Shovels.ai → contractor leads

`python -m ingestion.shovels` is the first step of the outreach cron job. It searches the
Shovels API for electrical contractors who filed a permit on a recent day, filters them
and outputs up to 10 leads per run. Each lead has a name, a primary email, the state and
the day of the permit, and the full contractor record.

```
python -m ingestion.shovels --out leads.json            # default: all states, 10 leads
python -m ingestion.shovels --states CA TX --max-leads 5 --out leads.json
```

The script reads `SHOVELS_API_KEY` from `.env` in the project root.

| File | Purpose |
|---|---|
| `shovels.py` | CLI entry point: parses args, loads state, runs `fetch_leads`, saves state |
| `client.py` | `ShovelsClient`: HTTP, retries, pagination and credit tracking |
| `leads.py` | `fetch_leads()`: picking days, state rotation and the credit-saving search loop |
| `filters.py` | `Blocklist` and `skip_reason()`: which contractors count as leads |
| `store.py` | Loading and saving the three JSON files below |
| `blocklist.json` | Big companies and email domains to never pitch |
| `seen_contractors.json` | Every contractor already fetched, with its outcome (written by the script) |
| `search_log.json` | Per state: days already searched within the lookback, and the date last searched (written by the script) |

The three JSON files are read only through `load_blocklist()`, `load_seen()`/`save_seen()`
and `load_search_log()`/`save_search_log()` in `store.py`. To move them into Postgres
later, only that module needs to change.

---

## Core tenet: a steady supply, not full coverage

**We don't need every contractor, only a steady supply of new ones: about 10 per day,
and that number may change.** Leaving contractors unreached is fine and even useful.
If feedback shows the outreach email needs fixing, plenty of contractors still haven't
been emailed. If we had already emailed everyone, there would be nobody left to try the
corrected email on.

So we never pay to be exhaustive. We take a date window once, use what we need from it
and move on, even if that means abandoning the rest of a day or missing permits that
Shovels adds late. Design choices below lean on this.

## No Alaska or Hawaii

**JoJoSpring can't ship to Alaska or Hawaii, so contractors there are never leads.** This
is enforced in three places:

- `US_STATES` in `shovels.py`, the default `--states`, leaves out `AK` and `HI`.
- `fetch_leads()` drops `filters.UNSHIPPABLE_STATES` from any state list it's given, even
  `--states AK`, before making any call. That includes the free coverage calls.
- `skip_reason()` rejects a contractor whose own `address.state` is `AK` or `HI`
  (status `"unshippable state"`). Permits are searched by where the work was done, but
  we'd ship to the contractor's address.

To change the list, edit `UNSHIPPABLE_STATES` in `filters.py`.

---

## The Shovels API: what we learned

Everything below was confirmed with live calls in October 2026, except where marked.
`shovels_executable/shovels.exe` is a thin wrapper around the API. Use
`--dry-run` to see the exact HTTP request a command sends (this costs no credits), and
`--schema` to see the response fields.

### Basics
- **Base URL:** `https://api.shovels.ai/v2`
- **Auth:** the header `X-API-Key: <key>`
- **List parameters are sent as repeated keys:** for example `permit_tags=electrical&permit_tags=solar`
  or `id=C1&id=C2`. The `requests` library does this when you pass a Python list.
- **Raw response shape:**
  `{"items": [...], "size": N, "next_cursor": "..." | null, "total_count": ...}`.
  The CLI rewraps this as `{"data", "meta"}`, but the raw API does not.
- **Pagination:** send `cursor=<next_cursor>` to get the next page. `next_cursor` is
  `null` on the last page. Changing `size` between pages works.
- **`size` must be at least 1.** `size=0` returns a 422 error, so there's no free
  count-only query.
- **`include_count=true`** returns `total_count: {"value": N, "relation": "eq"|"gte"}`.
  The count is capped at 10,000.
- **Sorting:** results come newest `file_date` first, and the API has no option to
  change the order.

### Endpoints used

| Endpoint | Use | Notes |
|---|---|---|
| `GET /permits/search` | Recent electrical permits (old flow, no longer used) | Required: `geo_id`, `permit_from`, `permit_to`. We also send `permit_tags=electrical` and `permit_has_contractor=true` |
| `GET /contractors?id=...` | Contractor details and emails (old flow, no longer used) | 1–50 IDs per call. Unknown IDs are left out of `items`. Same raw response shape |
| `GET /contractors/search` | **Used.** Contractors directly (see [how a run works](#how-a-run-works-contractor-search)) | Takes the same `geo_id` / date / `permit_tags` filters. Returns full contractor records, sorted by `id` |
| `GET /contractors/{id}/permits` | One contractor's permits | Not used yet |
| `GET /contractors/{id}/employees` | Individual people | Each has `business_email` and `email`; the second is personal, so skip it for cold outreach |
| `GET /list/tags` | Valid tag IDs | `electrical` is valid |
| `GET /meta/coverage` | **Used.** Free permit count per state and day (see [the completeness check](#free-completeness-check)) | Credit-exempt |
| `GET /usage` | Credit balance | Free |

### Permit filters
- **Dates filter on `file_date`.** `issue_date` is often null.
- **`geo_id`** is a 2-letter state, a 5-digit zip code or a Shovels ID (resolve those
  with `/cities/search` and similar). There is **no nationwide option**, so covering
  the whole US means looping over the states.
- **Other filters:** contractor classification (for example `electrical`),
  `property_type`, `min_job_value` (in cents) and `status`. Run
  `shovels.exe permits search --help` for the full list.
- **Unknown parameters are silently ignored.** The CLI flag `--contractor-classification`
  is sent to the API as `contractor_classification_derived`. Sending
  `contractor_classification` returned unfiltered results with no error and still cost
  credits. Run `--dry-run` to get the real parameter names before a paid call.

### Contractor fields that matter
- **`primary_email`:** a single string. This is the one we use.
- **`email`:** a **comma-separated string** of every address on record. It's noisy and
  includes permit-service and placeholder addresses.
- **Other contact fields:** `primary_phone`, `website`, `business_name`, `name` and `dba`.
- **Size signals:** `permit_count` (lifetime) and `total_job_value` (in cents).
  `employee_count` and `revenue` were always null.
- **`classification_derived`:** for example `["electrical", "general_building_contractor"]`.
  It's often null.

---

## Credits

**You're billed 1 credit per record returned, not per request.** The response headers
`X-Credits-Request`, `X-Credits-Remaining` and `X-Credits-Limit` report the cost. A
response with no records costs nothing and has no credit headers.

- A page of N permits costs N.
- A contractor lookup costs 1 per contractor returned.
- **Our account has a 500-credit limit.** About 410 went on exploration and testing in
  one day, leaving 89. Testing `/contractors/search` used 15 more, leaving 74.
- **The limit looks like a rolling 30 days.** `GET /usage` (free) lists credits per day,
  each with an `expires` date 30 days later. For example, the 411 used on 2026-10-21
  expire on 2026-11-20. This is inferred from the response, not confirmed with Shovels.

### Why contractor search: the old permit-based flow

The first version searched `/permits/search`, then looked up each new `contractor_id` with
`/contractors`. That meant two costs:

1. **`/permits/search`:** you pay for every permit, including permits from contractors
   you'll skip. The skip decision needs `contractor_id`, which you only get after
   paying for the permit.
2. **`/contractors`:** skipping an already-seen contractor avoids this lookup, so it
   saves only this cost.

Measured runs of the old flow (10 leads each):

| Run | Permits paid for | Contractors looked up | Credits |
|---|---|---|---|
| CA, no seen file, pages of 25 | 50 (32 used) | 26 | 76 |
| CA, rescanning seen contractors, pages of 25 | 50 (46 used) | 12 | 62 |
| AL, rotation and adaptive paging | 72 (all used) | 15 | 87 |
| AZ, rotation and adaptive paging | 41 (all used) | 29 | 70 |

**The main cost was repeat permits.** Alabama needed 72 permits to find 15 different
contractors, because active contractors file many permits and every one is paid for.
`/contractors/search` returns each contractor once, so it removes that cost.

### Cost controls in `leads.py`
- **Adaptive page size:** each page asks for at most the number of leads still needed.
  Even if every contractor on the page becomes a lead, the run stops at the end of the
  page, so no contractor is paid for and then left unused. `PAGE_SIZE = 25` is the upper limit.
- **Each (state, day) is searched at most once,** so no run pays to re-read a day.
- **Finding the starting day is free:** it uses the coverage endpoint, and empty days cost nothing anyway.
- **`--max-contractors`** (default 50) is a safety cap on contractors fetched, and so on
  credits, per run.
- **The seen file** records every contractor fetched, including rejected ones. A seen
  contractor that turns up again on another day still costs 1 credit, but it's skipped.

---

## Data lag: the newest day is still filling in

Daily counts of California electrical permits with a contractor, by `file_date`, taken on 2026-10-21:

```
Aug 18-20 (Tue-Thu): 264, 241, 230
Sep 15-17 (Tue-Thu): 362, 268, 208
Oct  5-9  (Mon-Fri): 224, 264, 186, 234, 158
Oct 10-11 (Sat-Sun):   6,  16
Oct 12    (Mon):      41   <- newest day with data, clearly incomplete
Oct 13-21:             0   <- not ingested yet
```

What this shows:
- **Data arrives about 9 days late**, in irregular batches. The delay isn't a fixed number of days.
- **The newest day is partial.** Oct 12 has 41 permits against about 200 on a normal weekday.
- **Older days look complete.** August and September counts are about the same size as
  early October, so there's little sign of permits being added to old days. This is one
  snapshot, though; re-measure it at some point.
- Weekends have very few permits.

The delay probably varies by state and by jurisdiction. Only California was measured.

---

## How a run works (contractor search)

This replaced the permit search, the `/contractors` lookups and a per-state watermark
of the newest `file_date` scanned.

`GET /contractors/search` takes the same filters as permit search and returns **each
contractor once**, as a full record that includes `primary_email`. Paying per contractor
instead of per permit removes the cost of repeat permits, and the `/contractors` lookup
goes away.

```
contractors/search (state, one day, permit_tags=electrical,       1 credit per contractor
                    contractor_classification_derived=electrical)
  -> filter: seen file, blocklist, permit_count, email            free
  -> optional: /contractors/{id}/permits size=1                    +1 credit per lead, gives a recent job to mention
```

**Measured:** the first live run (2026-10-21, default states, 10 leads) cost **22 credits**,
against 70–90 for the old flow. It fetched 22 contractors: 10 leads, 7 seen in earlier
runs, 4 with no primary email and 1 duplicate email.

**Sparse states use up their lookback quickly.** With both electrical filters, AL, AZ and
AR returned only 0–2 contractors a day, so that run searched every day from Oct 11 back to
Sep 21 in all three, plus one CA day. Empty days are free, so this costs no extra credits,
but those states give nothing more until new days arrive. AZ looked especially thin
compared with the old flow, which found 29 AZ contractors from 41 permits. Maybe many AZ
contractors have a null `classification_derived`, but that hasn't been checked. In Alabama, 15
contractor records would have replaced 72 permits plus 15 lookups.

### What live calls showed (2026-10-21, CA, Oct 5–12, 5 records each)
- **Billed per record:** 5 contractors cost 5 credits.
- **Sorted by contractor `id`, not by recency.** There's no newest-first order and no
  `file_date` in the results, so the results can't show how far Shovels' data has got.
- **Cursor pagination is keyset-based.** `next_cursor` looks like
  `Q0E.1HWt3Q01tj.5OQ.g9IIMnX6yL0`: base64 of the geo (`CA`), the id of the last
  contractor returned, and what looks like a signature. It holds no server-side state, so
  it shouldn't expire, but it must be stored exactly as returned, not built by hand.
- **`contractor_classification_derived=electrical` fixes lead quality.** Without it, all
  5 results were kitchen/bath remodelers, an HVAC shop and general contractors whose
  remodel permits carry an `electrical` tag. With it, all 5 were electrical contractors.
  It drops electricians with a null classification. In this small sample, every null was
  a non-electrician.
- 10 of 10 results had a usable `primary_email`, and 2 of 10 were already in the seen file.
- `permit_count` and `total_job_value` are lifetime figures, not scoped to the search.
  Only `tag_tally` and `status_tally` count the permits matching the search.

### Choosing dates
Following the [core tenet](#core-tenet-a-steady-supply-not-full-coverage), **each
(state, day) is searched at most once.** Each run:

1. Picks states least recently searched first. A state with no data still gets
   `last_searched` stamped, so it rotates to the back. With 10 leads a run, one state
   usually fills the run, which also spreads leads across the country.
2. Uses free coverage calls to find the state's newest day with any permits, within the
   `--days` lookback (default 30). That day is treated as partial and skipped.
3. Walks backward from the day before, skipping days already searched for that state.
4. Pages through each day with `next_cursor` until 10 leads pass the filters, marking
   the day searched. Days older than the lookback are dropped from `search_log.json`.

- **Empty days cost nothing.** A response with no records is free, so days Shovels hasn't
  ingested yet are just stepped past. That makes the irregular ~9-day lag harmless. A
  fixed "exactly 8 days ago" rule wouldn't work: on 2026-10-21 that day (Oct 13) had no
  data yet.
- **The starting day decides how much is lost to partial days.** A day is never revisited
  once searched, so if it was still filling in, its late permits are given up. Starting
  the day before the newest day with data, found with the
  [coverage check](#free-completeness-check), mostly avoids that.
- **The cursor isn't stored between runs.** Days are never searched twice, so no run
  re-reads contractors an earlier run already paid for. When a run stops partway through
  a day, the rest of that day is abandoned.
- **What is stored:** the days already searched per state, in `search_log.json`, plus the seen file. The same contractor files on many days, so repeats still
  come back. They cost 1 credit each and get skipped.

### Free completeness check
`GET /meta/coverage?geo_id=CA&geo_type=state&date_from=D&date_to=D` (CLI:
`shovels states coverage CA --coverage-from D --coverage-to D`) is **credit-exempt**. That
was confirmed on 2026-10-22: about 40 calls left the `/usage` balance unchanged. It
reports how often permit fields are filled, and each item carries `permits_total`, the
count of **all** permits in the window, not only electrical ones. When every field is
well filled, `items` is empty and there's no count. That never happened for a state on
any day we tried.

Daily `permits_total`, taken on 2026-10-22:

```
CA  Oct 5-9 (Mon-Fri): 2746, 2701, 2459, 2525, 1828    Aug 18: 3026, Sep 15: 3279
    Oct 10-11 (Sat-Sun): 467, 365
    Oct 12 (Mon):  435   <- partial: ~1/6 of a normal weekday
    Oct 13-21:       0
TX  Oct 5-9: 1687, 1915, 2052, 1928, 1702    Oct 10-11: 127, 69    Oct 12: 18 (partial)
WY  Oct 5-9: 41, 28, 26, 17, 11              Oct 10-12: 0
```

- **It matches the electrical counts.** CA electrical permits with a contractor are about
  8–9% of the total (224 of 2746 on Oct 5, 41 of 435 on Oct 12). The partial Oct 12 and
  the empty days after it show up the same way.
- **TX has the same lag as CA.** The newest day with data is Oct 12, and it's partial.
- **Small states give few leads per day.** WY has tens of permits a weekday, so maybe 1–3
  electrical contractors. The backward walk just takes more days there.
- **The date filter may not be exactly `file_date`.** `file_date` itself is only 30–43%
  filled on weekends and on Oct 12, so the window seems to use another or combined date.
  The totals still track the electrical counts, so it works as a signal.

**`leads.py` uses this to pick the starting day** (`_newest_day_with_data()`). It walks
backward with free coverage calls to the newest day with `permits_total > 0`, treats that
day as partial and starts the paid search the day before. In both CA and TX this starts on
Fri Oct 9. Not done yet: skipping days far below a state's normal weekday count.

---

## Lead quality

What the filters in `filters.skip_reason()` do:
- **Unshippable state:** the contractor's `address.state` is in `UNSHIPPABLE_STATES`
  (see [No Alaska or Hawaii](#no-alaska-or-hawaii)).
- **`permit_count` > 500 is too large.** Tesla has about 75k, NRG Clean Power about 4.4k.
  Small shops have 1–200.
- **Blocklisted company:** whole-word matching on `business_name`, `name` and `dba`
  against `blocklist.json` `companies`. Matching ignores case and punctuation, so
  "Sunrun Inc." is blocked but "Sunrunner Electric" isn't.
- **No primary email**, or a **blocked email**, meaning:
  - a domain in `blocklist.json` `email_domains`,
  - any `.gov` domain, because those are permit offices and agencies, not contractors, or
  - a junk name like `no@`, `none@` or `test@`.
- **Duplicate email:** another contractor, in this run or an earlier one, already has it.

Things we learned:
- **Even `primary_email` can be a permit-service company's address**, for example
  `north@ipermitca.com` on several contractors. Add those domains to `email_domains`.
- **Large firms can have small `permit_count` values.** This happened with Sunrun (43),
  PCL (3) and Sundt (399), probably because their permits are split across many license
  records. The blocklist catches them.
- **Electrical permits are also pulled by non-electricians:** alarm and security
  companies, HVAC companies, utilities (Arizona Public Service) and solar installers.
  `contractor_classification_derived=electrical` filters them out on the server at no
  cost, as tested on `/contractors/search`. It also drops electricians whose
  classification is null (Surgeon Electric was one).
- About a quarter to a third of contractors looked up had no usable primary email.
- **Permit offices with non-`.gov` domains get through.** Jefferson County, AL uses
  `epermitjc_registration@jccal.org`. Add such domains to `email_domains` as they appear.

Deliberately **not** filtered:
- **Fire-alarm and fire-protection companies.** They show up under the electrical
  classification. Telling them apart from electricians would take an LLM step, and a name
  filter on "fire" could drop a legitimate electrician with "fire" in the company name.
  They're accepted as leads.
- **Role addresses** like `accounting@` or `licensing@`. They're less likely to reach the
  owner, but they're real company inboxes, so they're accepted too.

---

## Open issues / TODOs
- [x] Switch to `/contractors/search`, starting each state the day before its newest day with data.
- [x] Do a live run and measure credits per lead: 22 credits for 10 leads.
- [ ] Check whether the classification filter is too strict in states like AZ.
- [ ] Measure how many real electricians `contractor_classification_derived=electrical` drops.
- [ ] **"Seen" means fetched, not emailed.** If the email step fails, that contractor is
      never returned again. When this moves to Postgres, track `emailed_at` separately.
- [ ] Move the seen file, search log and blocklist to Postgres (only `store.py`
      changes).
- [ ] **Credits:** the account has a 500 limit and 74 are left after testing. A daily run
      at about 70–90 credits needed a paid plan. Contractor search should fit about 15–30 a day.
- [ ] Re-measure the data lag on other days, to confirm older days really don't change.
      The coverage check makes this free: log each state's daily `permits_total` per run.
- [ ] Keep growing `blocklist.json` as bad leads appear.
- [x] Move the mock tests into the repo (`tests/test_ingestion.py`).

## Testing
```
python -m pytest
```
`tests/test_ingestion.py` replaces `ShovelsClient._get` with a fake API, so the tests make
no network calls and use no credits. The fake serves `/contractors/search` sorted by id
with a keyset cursor and the classification filter, serves `/meta/coverage` counts, and
bills 1 credit per contractor returned, the way the real API does. The tests cover:
- skipping the newest, partial day, and moving the start when a new batch lands
- each (state, day) being searched only once, and old days being dropped from the log
- walking back across days until leads are full
- rotation, including states with no data
- no paid-for contractor going unused, and the `--max-contractors` cap
- the exact classification parameter name, which the real API would silently ignore if misspelled
- every skip reason, and Alaska and Hawaii never being searched or kept
- blocklist matching

When you change how `fetch_leads` pages through results, check `test_no_paid_contractor_goes_unused`.
It catches credit waste.
