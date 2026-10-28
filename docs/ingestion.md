# Ingestion: Shovels.ai → contractor leads

Ingestion (`ingest_()` in `gas/src/daily.js`, run by `dailyRun()`) is the first step of the outreach pipeline. It
searches the Shovels API for electrical contractors who filed a permit on a recent day,
filters them and writes at least 10 new leads per run to the leads tab of the Sheet. Each
lead in memory has a name, primary email, phone, city, state, permit day, project type
(from `tag_tally`), zip code and the full contractor record. Only `contractor_id, name,
zip_code, email` are written to the Sheet (sending adds `emailed_at` and `thread_id`); the
rest is there for the send step's template.

`dailyRun()` spends credits. The weekday trigger runs it behind the credit guard (see
[Credits](#credits)); running it by hand from the editor still needs the user's approval.
It reads `SHOVELS_API_KEY` from Script Properties.

| File (`gas/src/`) | Purpose |
|---|---|
| `main.js` | Entry points: `setup()`, `dailyRun()`, `setupTriggers()`, and the `UrlFetchApp` adapter |
| `daily.js` | `runDaily_()`: kill switch, credit guard, `ingest_()`, sending and the run_log row. Also the trigger schedule |
| `client.js` | `ShovelsClient`: HTTP, retries, one page of contractor search, coverage counts, credit tracking |
| `leads.js` | `fetchLeads()`: picking days, state rotation and the credit-saving search loop. Also `US_STATES` |
| `filters.js` | `Blocklist` and `skipReason()`: which contractors count as leads |
| `store.js` | Reading and writing the leads, search_log and blocklist tabs |
| `schema.js`, `setup.js` | The tabs and columns, and `setupSheets()`, which creates them idempotently |

| Tab | Written by | Holds |
|---|---|---|
| `leads` | the script | Every lead found. Also the do-not-contact-again list, by `contractor_id` and email |
| `search_log` | the script | Per state, the days already searched as inclusive ranges, and `searched_at` for rotation |
| `blocklist` | the user, by hand | Big companies and email domains to never pitch |

Only `store.js` touches the Sheet, and it finds columns by header name.

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
is enforced in three places, each with a test:

- `US_STATES` in `leads.js`, the state list `ingest_()` passes, leaves out `AK` and `HI`.
- `fetchLeads()` drops `UNSHIPPABLE_STATES` from any state list it's given, even `['AK']`,
  before making any call. That includes the free coverage calls.
- `skipReason()` rejects a contractor whose own `address.state` is `AK` or `HI`
  (status `"unshippable state"`). Permits are searched by where the work was done, but
  we'd ship to the contractor's address.

To change the list, edit `UNSHIPPABLE_STATES` in `filters.js`.

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
  or `id=C1&id=C2`. `toQuery_()` in `client.js` does this for array values.
- **Raw response shape:**
  `{"items": [...], "size": N, "next_cursor": "..." | null, "total_count": ...}`.
  The CLI rewraps this as `{"data", "meta"}`, but the raw API does not.
- **Pagination:** send `cursor=<next_cursor>` to get the next page. `next_cursor` is
  `null` on the last page. Changing `size` between pages works.
- **`size` must be at least 1.** `size=0` returns a 422 error, so there's no free
  count-only query. The client refuses a size below 1 before sending.
- **`include_count=true`** returns `total_count: {"value": N, "relation": "eq"|"gte"}`.
  The count is capped at 10,000.
- **Sorting:** permit results come newest `file_date` first, and the API has no option to
  change the order.

### Endpoints

| Endpoint | Use | Notes |
|---|---|---|
| `GET /permits/search` | Recent electrical permits (old flow, no longer used) | Required: `geo_id`, `permit_from`, `permit_to`. We also sent `permit_tags=electrical` and `permit_has_contractor=true` |
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
  credits. Run `--dry-run` to get the real parameter names before a paid call. On
  2026-10-26 the JS client's request matched `shovels.exe contractors search --dry-run`
  exactly.

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
  one day. On 2026-10-26, before the first Apps Script run, 52 were left.
- **The limit looks like a rolling 30 days.** `GET /usage` (free) lists credits per day,
  each with an `expires` date 30 days later. For example, the 411 used on 2026-10-21
  expire on 2026-11-20. This is inferred from the response, not confirmed with Shovels.
- **`GET /usage` raw response** (checked 2026-10-28, 35 left): `{"credits_used": 465,
  "credit_limit": 500, "is_over_limit": false, "available_at": null, "daily_usage":
  [{"date", "credits", "expires"}, ...]}`. The CLI wraps this in `{"data": ..., "meta": {}}`;
  the API itself doesn't. `ShovelsClient.usage()` reads it as remaining = limit − used.

### Credit guard
`dailyRun()` asks `/usage` before any paid call and skips ingestion (still sending any
pending leads) when fewer than `MIN_CREDITS_TO_RUN` (20) are left, the account is over
its limit, or the balance can't be read. A run then fetches at most `RUN_CREDIT_CAP` (20)
contractors. The cap is never above the floor, so a run can't overdraw. Both thresholds were
set by the user on 2026-10-28. Every run, skipped or not, adds a row to the `run_log` tab
with credits used and remaining.

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

### Cost controls in `leads.js`
- **Adaptive page size:** each page asks for at most the number of leads still needed.
  Even if every contractor on the page becomes a lead, the run stops at the end of the
  page, so no contractor is paid for and then left unused. `PAGE_SIZE = 25` is the upper limit.
- **Every lead on a paid page is kept.** `targetLeads` is a minimum, not a cap: if a page
  ever holds more good leads than needed, all of them are written.
- **Each (state, day) is searched at most once,** so no run pays to re-read a day. A day
  is marked searched before it's fetched, so a failure partway doesn't cause a re-read.
- **Finding the starting day is free:** it uses the coverage endpoint, and empty days cost nothing anyway.
- **`maxContractors`** (`RUN_CREDIT_CAP`, 20, in `ingest_()`) is a hard cap on contractors
  fetched, and so on credits, per run.
- **Saved on failure:** if a run throws partway, the leads found so far and the search
  log are still written, so nothing paid for is lost.

### Why there's no seen-contractors list
The Python version kept a file of every contractor fetched, including rejected ones. It
saved no credits: a contractor that turns up again is billed before we can skip it. So
the Apps Script version keeps only the leads tab. A contractor already there (by id or
email) is skipped as `"already a lead"`. A rejected contractor isn't stored and is just
filtered again for free, so a blocklist edit takes effect on the next run.

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
  -> filter: leads tab, blocklist, permit_count, email             free
  -> optional: /contractors/{id}/permits size=1                    +1 credit per lead, gives a recent job to mention
```

**Measured runs:**

| Run | Contractors (credits) | Leads | Skipped |
|---|---|---|---|
| Python, 2026-10-21, default states | 22 | 10 | 7 seen in earlier runs, 4 no primary email, 1 duplicate email |
| Apps Script, 2026-10-26, empty Sheet | 17 | 10 | 3 no primary email, 2 already a lead, 2 too large |

The old flow cost 70–90 credits for 10 leads. In the Apps Script run, "already a lead"
means the same contractor came back on a second day within the run.

**Sparse states use up their lookback quickly.** With both electrical filters, AL, AZ and
AR returned only 0–2 contractors a day, so the first Python run searched every day from Oct 11 back to
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

1. Picks states least recently searched first (`searched_at` in the search_log tab). A
   state with no data still gets a row with blank start/end and `searched_at` stamped,
   so it rotates to the back. With 10 leads a run, one state usually fills the run,
   which also spreads leads across the country.
2. Uses free coverage calls to find the state's newest day with any permits, within the
   lookback (`days`, default 30). That day is treated as partial and skipped.
3. Walks backward from the day before, skipping days already searched for that state.
4. Pages through each day with `next_cursor` until at least 10 leads pass the filters,
   marking the day searched. Days older than the lookback are dropped from the search log.

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
- **What is stored:** the days already searched per state (as ranges in the search_log
  tab) and the leads tab. The same contractor files on many days, so repeats still come
  back. They cost 1 credit each and get skipped.

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

**`leads.js` uses this to pick the starting day** (`newestDayWithData()`). It walks
backward with free coverage calls to the newest day with `permits_total > 0`, treats that
day as partial and starts the paid search the day before. In both CA and TX this started on
Fri Oct 9. Not done yet: skipping days far below a state's normal weekday count.

Apps Script stops a run after 6 minutes. A state with no data in the lookback costs
about 31 free coverage calls, so a run that meets many empty states could get close to
that limit. Call latency from Apps Script hasn't been measured.

---

## Lead quality

What `skipReason()` in `filters.js` does:
- **Unshippable state:** the contractor's `address.state` is in `UNSHIPPABLE_STATES`
  (see [No Alaska or Hawaii](#no-alaska-or-hawaii)).
- **`permit_count` > 500 is too large.** Tesla has about 75k, NRG Clean Power about 4.4k.
  Small shops have 1–200.
- **Blocklisted company:** whole-word matching on `business_name`, `name` and `dba`
  against the blocklist tab's `company` column. Matching ignores case and punctuation, so
  "Sunrun Inc." is blocked but "Sunrunner Electric" isn't.
- **No primary email**, or a **blocked email**, meaning:
  - a domain in the blocklist tab's `email_domain` column,
  - any `.gov` domain, because those are permit offices and agencies, not contractors, or
  - a junk name like `no@`, `none@` or `test@`.

`fetchLeads()` adds two more:
- **Already a lead:** the `contractor_id` is in the leads tab or was found earlier in the run.
- **Duplicate email:** another lead, in the leads tab or this run, already has the email.

Things we learned:
- **Even `primary_email` can be a permit-service company's address**, for example
  `north@ipermitca.com` on several contractors. Add those domains to the blocklist tab.
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
  `epermitjc_registration@jccal.org`. Add such domains to the blocklist tab as they appear.

Deliberately **not** filtered:
- **Fire-alarm and fire-protection companies.** They show up under the electrical
  classification. Telling them apart from electricians would take an LLM step (JJ-17),
  and a name filter on "fire" could drop a legitimate electrician with "fire" in the
  company name. They're accepted as leads.
- **Role addresses** like `accounting@` or `licensing@`. They're less likely to reach the
  owner, but they're real company inboxes, so they're accepted too.

---

## Open issues / TODOs
- [ ] Check whether the classification filter is too strict in states like AZ.
- [ ] Measure how many real electricians `contractor_classification_derived=electrical` drops.
- [x] Credit guard before any ingestion trigger: `creditGuard_()` in `daily.js` (2026-10-28).
- [ ] Re-measure the data lag on other days, to confirm older days really don't change.
      The coverage check makes this free: log each state's daily `permits_total` per run.
- [ ] Keep growing the blocklist tab as bad leads appear.
- [ ] Log each skipped contractor (id, name, reason), not just counts, to make runs easier to audit.

## Testing
```
cd gas && npm test
```
`gas/test/ingestion.test.js` passes a fake Shovels API (`FakeShovels` in `fakes.js`)
into `ShovelsClient` at the HTTP level, so the tests make no network calls and use no
credits. The fake serves `/contractors/search` sorted by id with a keyset cursor and the
classification filter, serves `/meta/coverage` counts, and bills 1 credit per contractor
returned, the way the real API does. The tests cover:
- skipping the newest, partial day, and moving the start when a new batch lands
- each (state, day) being searched only once, and old days being dropped from the log
- walking back across days until leads are full
- rotation, including states with no data
- no paid-for contractor going unused, every lead on a paid page being kept, and the
  `maxContractors` cap
- the exact parameter names and repeated-key encoding, which the real API would silently
  ignore if wrong
- every skip reason, and Alaska and Hawaii never being searched or kept
- blocklist matching, retries, and leads surviving a failure partway through a run

`gas/test/sheets.test.js` covers `setupSheets()` and the store against a fake
SpreadsheetApp, including a two-run flow through the Sheet.

When you change how `fetchLeads` pages through results, check `no paid contractor goes
unused`. It catches credit waste.
