# Responders: who engaged with JoJoSpring

Shovels data on the contractors who responded to outreach, plus the one customer who bought
before outreach started. It's here to test the targeting ideas in `README.md` ("Targeting")
against real responses. Records were fetched on 2026-11-17 for 8 credits: 2 contractor
records and 3 most-recent permits each. Contact details are left out on purpose; look them
up by `contractor_id`.

As of 2026-11-17: **2 responses from 71 emails.** That's too few to measure anything, so
read this as clues, not proof.

| | Jarrett Electric LLC | Signcraft Premier Identity Solutions | Cornerstone Electric (AZ) |
|---|---|---|---|
| Response | Made a jojospring.com account and put 2 chandeliers in the cart. No purchase, no reply | Replied: they buy from wholesale lighting distributors, but will keep JoJoSpring in mind | **Bought one fixture**, before outreach started: the Mariana cognac glass cluster pendant in antique black. Buyer was the company president, who used the company email and put the company name on the account |
| `contractor_id` | `EiF02W83Vw` | `Qj2WsFZ6Na` | not looked up (found us on their own) |
| What they are | Owner-operated residential electrician | Sign maker that installs illuminated signs | Commercial and industrial electrical contractor |
| Where | Bend / La Pine, Deschutes County, OR | Roseburg area, OR; jobs across western OR | Tucson, AZ |
| Size | 76 lifetime permits; avg job $6,160 | 123 permits; avg job $6,519; under $1M revenue, 1–10 employees | 7 people on the website's team page |
| `classification_derived` | `["electrical"]` | `["electrical"]` | n/a |
| License classification | C-Electrical Contractor | C-Electrical Contractor | n/a |
| Lifetime `tag_tally` | electrical 76, electric_meter 25, hvac 4, remodel 3, addition 3, bathroom 3, generator 2, kitchen 1, new_construction 1, solar 1, ev_charger 1, window_door 1 | electrical 92, remodel 6 | n/a |
| Recent permits | Residential single-family: a 200A meter + RV outlet, a bedroom/bath/family-room **addition** ("Residential electrical / Addition"), a meter change | All commercial: Burger King sign replacement, an illuminated dealership sign, an illuminated monument sign for a retail site | n/a |
| Industry codes | `sic`, `naics` null | **`sic` 3993 (signs), `naics` 339950 (sign manufacturing)** | n/a |
| Email type | Personal webmail (owner's own inbox) | Company role inbox (`signs@`) | n/a |

**Jarrett's cart** (both under Chandeliers > Glass Chandelier):
- Lynn antique glass cluster pendant: antique black and brown with cognac glass, vintage, $235.88.
- Daniela 5-light linear chandelier: antique black metal, natural wood and clear glass, farmhouse/rustic, $99.99 on sale (was $176.40).

**Cornerstone** (from cornerstoneelectricaz.com, not Shovels): calls itself a full-service
electrical contractor for industrial and commercial construction, maintenance and energy
savings. No mention of residential work, lighting or fixtures.

## Analysis

**1. Jarrett is the target profile, and the proposed filters keep them.** A one-person
residential electrician in a small market, reached at the owner's own inbox, shopping
mid-priced farmhouse/vintage chandeliers for a home. They pass `classification_derived=electrical`,
`property_type=residential` and the 500-permit cap. Their most likely reason to shop is the
addition job (a new bedroom, bath and family room means new fixtures).

**2. Excluding `electric_meter` would have lost Jarrett.** Two of their three recent permits
are meter or service jobs tagged `electric_meter`, and a third of their lifetime permits
carry it. If the day we found them was a meter day, the exclude would have dropped them.
This supports keeping the tag exclude list to specialist-only tags (`solar`, `battery`,
`ev_charger`, `generator`, `fire_sprinkler`, `telecom`).

**3. Signcraft is the kind of lead the filters should drop, and they would.** It's a sign
company that holds an electrical license because its signs are illuminated. Every recent
permit is commercial, so `property_type=residential` would probably have excluded it. Two
more free signals catch it on records we already pay for:
- `naics` / `sic` were filled in for Signcraft (they're often null). A reject list of
  industry codes (signs 339950/3993, and later security/fire-alarm codes) would cost nothing.
  See [Industry codes](ingestion.md#industry-codes-naics-and-sic) in `docs/ingestion.md`.
- Its `tag_tally` has no residential job tags beyond a few `remodel`.

**4. Their reply shows how commercial buyers buy.** Commercial installers buy through
wholesale lighting distributors, often under contract or spec. A direct-to-consumer store
doesn't fit that channel, which is another reason to focus on residential work, where the
installer or owner picks the fixtures.

**5. Cornerstone was probably a one-off purchase, not a commercial job.** The only paying
customer so far is a commercial/industrial firm, but the order was a single decorative
pendant, not a quantity for a job. A home, an office lobby or one client's request are all
possible; the company email and company name on the account mean it was at least partly a
business purchase. It doesn't show that commercial contractors are a buying segment, so it
doesn't argue against `property_type=residential`. It does show that people in the trade
pick JoJoSpring for single statement pieces.

**5b. Both buyers chose almost the same fixture.** Cornerstone bought the Mariana cognac
glass cluster pendant in antique black. Jarrett's most expensive cart item, the Lynn, is
also a cognac glass cluster pendant in antique black. Two separate contractors converging on
one look is worth passing on: it could lead the email, or be the one product the template
links to.

**6. All three are small, and the owner or president was reached directly.** That supports
the 500-permit cap and favors personal or owner inboxes over role addresses (`accounting@`,
`signs@`).

**7. Both responders are in Oregon, which got only 10 of the 71 emails (14%).** If
responses were spread evenly, the chance both would be Oregon is about 2% (0.14²). That's
suggestive, not conclusive, with 2 responses. Possible reasons to check:
- Oregon's license data may carry owners' own emails more often (Jarrett's was personal Gmail).
- Timing: if the Oregon emails went out on a particular day or with a template version.
- Market: Oregon permit volume is smaller, so small owner-operated shops make up more of it.

If it holds up, searching Oregon (and similar states) more often is a cheap change to the
state rotation.

## Data notes
- `GET /contractors?id=` returns **lifetime** `tag_tally` and `status_tally`, not counts for a
  search window. Contractor search returns the window counts only.
- `naics`, `sic`, `revenue`, `employee_count`, `rating`, `review_count` and `website` were all
  filled in for Signcraft but null for Jarrett. They're sometimes there, not always null as
  earlier runs suggested.
- `job_value` was filled on 4 of 6 permits; `property_assess_market_value` on none.
