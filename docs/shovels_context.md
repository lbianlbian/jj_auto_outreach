CONTEXT: JoJoSpring is a small online store selling DECORATIVE lighting (chandeliers,
pendants, sconces, flush mounts): good quality at low prices, not industrial lighting.
We cold-email ~10 US contractors/day found via building permits (Shovels.ai API), hoping
to reach whoever chooses/buys fixtures on a job. Question: how should we filter the set
of electricians and general contractors down to likely buyers of decorative fixtures?

CONSTRAINTS
- Shovels bills 1 credit per record returned; we have ~500 credits per rolling 30 days
  and spend <=20 per run. Server-side filters are effectively free (you only pay for
  matches; empty results cost 0). Client-side filtering means paying first.
- Runs in Google Apps Script; any extra service must be a simple HTTP call.
- No Alaska/Hawaii (can't ship).
- We don't need full coverage, only a steady trickle of good leads.

SHOVELS DATA
Search is per US state, zip code, city or county (no nationwide query) + date range of
permit filing. Data lags ~9 days.

Permit tags (complete list, 24): addition, adu, bathroom, battery, demolition,
electric_meter, electrical, ev_charger, fire_sprinkler, gas, generator, grading,
heat_pump, hvac, kitchen, new_construction, plumbing, pool_and_hot_tub, remodel,
roofing, solar, telecom, water_heater, window_door.
Tag filters are AND-only (with "-" to exclude); there is no OR. No tag for lighting,
fixtures, fire alarm or low voltage; the only lighting signal is a free-text substring
search on the permit description (one term per query).

Server-side filters available on contractor search (match contractors with >=1 permit
in the window meeting them):
- Permit: tags (AND logic, can exclude with "-", e.g. electrical,-solar), one free-text
  substring on the permit description (<=50 chars), min job value, min fees, status
  (active/final/in_review/inactive), min approval/construction duration
- Property: type (residential, commercial, industrial, office, recreational, ...),
  min assessed market value, min building area, min lot size, min stories, min units
- Contractor: derived classification (electrical, general_building_contractor, hvac,
  plumbing, roofing, specialty_trades, ... AND logic, excludable), min lifetime permit
  count, min lifetime total job value, name substring, license number, website domain

Fields returned per contractor (we pay for each record):
- Contact: name, business_name, dba, primary_email, phone, address
- Lifetime stats: permit_count, avg_job_value, total_job_value, inspection pass rate
- Window-specific: tag_tally (count of permits per tag in the search), status_tally
- Classification: classification (license), classification_derived
- In the schema but in practice null/sparse: website, linkedin_url, revenue,
  employee_count; naics, sic, primary_industry, rating, review_count unverified
- No bio or free text about the company.

Extra paid lookups:
- A contractor's permits: description text, normalized description, job value,
  property type/detail, assessed market value, year built, unit count, owner type
- A contractor's employees: job title, department, business email
- Monthly metrics per contractor by property type + tag

WHAT WE SEE TODAY: filtering on classification=electrical gives real electricians, but
also fire-alarm/sprinkler/security/solar firms. Without it we get remodelers, HVAC and
GCs. ~25-33% have no usable email. Some emails are permit-service companies.

OPEN QUESTIONS
1. On residential jobs, who picks and buys decorative fixtures: electrician, GC/
   remodeler, designer or homeowner? Should we target GCs/remodelers instead of, or
   as well as, electricians?
2. Which segments want "good quality, cheap": flippers, spec builders, landlords,
   small remodelers?
3. Which Shovels filters/signals best predict that segment?
4. Which cheap outside signal (Google Places, website + LLM, state license DB) adds the
   most?