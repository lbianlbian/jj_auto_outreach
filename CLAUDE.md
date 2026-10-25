# CLAUDE.md

A CS 146S (Stanford) project that automates B2B cold outreach for JoJoSpring
(jojospring.com), a small online lighting-fixture store. The pipeline finds electrical
contractors who recently filed permits, emails them a pitch, and tracks responses. The
goal is a steady trickle of about 10 new leads a day until someone who needs light
fixtures replies. It doesn't try to cover every contractor.

## Ownership of docs
- `README.md` is the human-readable version, maintained by the user. **Don't edit it**
  unless asked. If it disagrees with this file, `README.md` wins. Tell the user about the
  drift instead of guessing.
- `docs/proposal.md` and `docs/technical_spec.md` were written before any work started.
  Use them for business context and for what each stage should do. Two parts are superseded:
  their "LLM writes each email" step, and their infrastructure (Render.com cron,
  Postgres, a separate dashboard). See Decisions. Where research changes something else,
  the user will say so.
- `ingestion/CLAUDE.md` is the detailed reference for the Shovels API, credits, data lag
  and lead filters. Read it before touching ingestion in either language.
- `docs/plan.md` is the human-written task plan that gets turned into Linear tasks. Don't
  edit it unless asked. Suggesting tasks to add, change or remove is welcome.

## Status

| Stage | State | Where |
|---|---|---|
| Ingestion | Done in Python, to be ported to Apps Script | `ingestion/`, writes `leads.json`. Will write to a leads Sheet |
| Send email | Not started | Apps Script, `GmailApp`. Fills a template the user edits by hand |
| Tracking | Not started | Apps Script + Google Sheet. Records sent emails and marks replies. Also a kill switch that stops everything when someone replies, or when the user pulls it to apply what they've learned |
| Scheduling | Not started | Apps Script time-based triggers |

**Next step:** set up clasp and the Apps Script project (Linear JJ-10). Linear has the
current task list and order. See Linear below.

## Linear (task tracking)
Tasks live in the Linear project **JJ auto outreach** (team `JJ`), reached through the
`linear-server` MCP. Using it is a course requirement, so Linear must not drift from the
repo.

- **Use it to get your bearings.** At the start of a task, or whenever you're unsure what's
  done, what's next or why something is scoped the way it is, list the project's issues.
  Each issue description has the scope, constraints and "done when" for that piece of work,
  and blocked-by relations show the order. If Linear and the code disagree, trust the code
  and tell the user.
- **End every task by suggesting Linear updates.** As the last step, list the changes
  your work implies: status moves (Todo → In Progress → Done), new issues you discovered,
  issues to edit (scope, description, dependencies), and issues to cancel or remove. Give
  the issue IDs. Apply them once the user agrees. Never delete an issue without asking;
  prefer Canceled.
- **New issues** get a title, a description (scope, constraints, "done when"), a status,
  a priority (High/Medium/Low), the `JJ auto outreach` project and blocked-by relations
  where they apply. Match the style of the existing issues.
- **Remind the user to update `docs/plan.md`** whenever a Linear change adds, finishes,
  renames or removes a task. That file is theirs to edit, so don't change it yourself.
  Say which lines need to change.

## Decisions (don't re-litigate)
- **Everything runs in Google Apps Script (GAS), developed locally with `clasp`.** This
  replaces the Render.com + Postgres plan. Reasons (from `README.md`): clasp lets agents
  develop and deploy GAS, Render cron jobs cost money, a Sheet-based system is simpler
  for a non-technical business owner to use, and practicing agentic GAS development is
  a course goal. Don't propose Render, Postgres, a Cloud-project Gmail API client, or a
  self-hosted MCP server for Apps Script.
- **Google Sheets is the datastore and the dashboard.** Leads, sent emails, replies,
  seen contractors, the search log, the blocklist and the kill switch live in Sheet tabs.
  The Sheet also powers a simple HTML dashboard served by the Apps Script web app. Both
  views stay available: the Sheet for raw data and editing, the HTML page for a summary.
- **Ingestion gets ported from Python to JS, tests first.** Port the pytest suite to JS
  (run with Node, offline), then port the code until it passes. Keep the Python code as
  the reference until the user says the JS version replaces it.
- **Emails come from a template, not an LLM.** The Shovels data has no bio or free text
  worth personalizing from. Website, LinkedIn, revenue, employee count and industry are
  always null. The template takes slots (contact name, company, city, and project type
  from `tag_tally`). The user writes and edits the template by hand. Don't build LLM
  generation of templates or emails.
- **A planned later LLM use is lead filtering.** It would be a yes/no "does this company
  buy light fixtures?" check, e.g. to drop fire-alarm and sprinkler companies, which
  pass the electrical classification filter today. Not implemented.
- **Never ship to Alaska or Hawaii.** This is enforced in `ingestion/` in three places
  (see `ingestion/CLAUDE.md`). The JS port must keep all three, with tests, and no new
  stage may undo it.

## Commands
```
# Python (current ingestion)
python -m pytest                                   # all tests; offline, no credits
python -m ingestion.shovels --out leads.json       # LIVE: spends Shovels credits
python -m ingestion.shovels --states CA TX --max-leads 5 --out leads.json
shovels_executable/shovels.exe <cmd> --schema      # response fields, free
shovels_executable/shovels.exe <cmd> --dry-run     # exact HTTP request, free

# Apps Script
clasp push                                         # local files -> GAS project
clasp deploy -i <deploymentId>                     # update existing deployment, same URL
clasp open                                         # open the script in the editor
```
Windows machine, Python 3.13. `pytest.ini` sets `testpaths = tests` and `pythonpath = .`.
clasp v3 renamed some commands (e.g. `update-deployment`), so check `clasp --help`
before relying on the names above.

## Hard rules
- **Shovels credits are scarce and real.** Billing is 1 credit per record returned. The
  account has a 500-credit rolling 30-day limit, and most of it is used up. **Never make
  a paid Shovels call unless the user approves it first.** That covers running
  `ingestion.shovels` without the mock, running a GAS function that fetches from Shovels,
  and creating or enabling a trigger that does. Free calls: `--schema`, `--dry-run`,
  `GET /usage`, `/meta/coverage`, and any response with zero records.
- **Unattended credit spending is not approved yet.** A trigger that runs ingestion needs
  a guard first: check free `GET /usage` and skip the run below a threshold, enforce a
  hard per-run record cap, honor the kill switch, and log every spend to a Sheet tab.
  The guard needs offline tests. The user sets the thresholds and must sign off before
  any ingestion trigger is enabled.
- **The API silently ignores unknown parameters**, and those calls still cost credits.
  Check parameter names with `--dry-run` before any approved paid call, including from
  the JS port.
- `.env` holds `SHOVELS_API_KEY` locally. In GAS the key lives in Script Properties,
  never in source files that clasp pushes. Never print it, log it or commit it.
- **OAuth consent is manual.** Scopes are declared in `appsscript.json` (`oauthScopes`).
  The first deploy, and any scope change (e.g. adding Sheets), requires the user to run a
  function in the editor and click through consent. Tell the user when that's needed.
  Don't try to work around it. Create triggers in code (a `setupTriggers()` function),
  and have the user run it in the same editor step.
- **Deploy to the existing deployment** (`-i <deploymentId>`) so the `/exec` URL doesn't
  change. Never create a new deployment unless asked. A web app deployed as "Anyone"
  must check a shared secret from Script Properties in the request body.
- `ingestion/seen_contractors.json` and `ingestion/search_log.json` are written by the
  script. Don't hand-edit them. `ingestion/blocklist.json` is hand-maintained, so add
  bad domains and companies there (and to the blocklist tab once it exists). All JSON
  files are gitignored on purpose: they're local state that is moving to Sheets.
- In Python, read and write JSON state only through `ingestion/store.py`. In GAS, keep
  all Sheet access in one store module the same way, so the rest of the code doesn't
  know where data lives.
- **Tests must stay offline in both languages.** Python tests replace
  `ShovelsClient._get` with a fake API. In JS, pass a fetch function into the logic
  instead of calling `UrlFetchApp`, `GmailApp` or `SpreadsheetApp` directly, so tests can
  pass fakes. When you change how leads are paged through, make sure the paging test
  (`test_no_paid_contractor_goes_unused` and its JS port) still passes, because it
  catches credit waste.

## Layout
```
docs/                 proposal.md, technical_spec.md, plan.md (see Ownership of docs)
ingestion/            Python Shovels -> leads (shovels.py CLI, client.py, leads.py, filters.py, store.py)
leads.json            latest Python run's output: name, email, phone, state, permit_date, full contractor record
shovels_executable/   vendored Shovels CLI binary and its README
tests/                pytest suite for ingestion (test_ingestion.py)
```
The Apps Script project (clasp root, JS source and Node tests) doesn't exist yet. Ask
the user where it should go before creating it.

## Known gaps relevant to the next stages
- "Seen" means fetched, not emailed. If sending fails, that contractor is never returned
  again. The send and tracking stages should record `emailed_at` separately in the Sheet.
- `primary_email` is sometimes a role address (`accounting@`, `licensing@`) or a
  permit-service address. Role addresses are accepted. Permit-service domains belong in
  the blocklist.
- To track replies, save the Gmail thread ID for each send. `GmailApp.sendEmail()`
  returns nothing, so use `GmailApp.createDraft(...).send()` and store
  `getThread().getId()`.
