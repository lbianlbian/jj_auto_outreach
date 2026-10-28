/**
 * The daily run: kill switch, bounce check, credit guard, ingestion, sending, run log, in
 * that order. Shovels comes in as a client and Gmail work as callbacks, so tests can run
 * the whole thing with fakes. main.js wires in the real services and the trigger.
 */

// Hard cap on contractors (= credits) one run may fetch, and the balance /usage must show
// before a run may spend. The cap never exceeds the floor, so a run can't overdraw.
// Set by the user on 2026-10-28; change them only with the user's say-so.
const RUN_CREDIT_CAP = 20;
const MIN_CREDITS_TO_RUN = 20;

// dailyRun() fires between this hour and the next, script time zone, Monday to Friday.
const DAILY_RUN_HOUR = 7;
const DAILY_RUN_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
const DAILY_RUN_HANDLER = 'dailyRun';

/**
 * One run. steps: {today, now(), checkBounces(), send(freshLeads) -> emails sent}.
 * Writes one run_log row whatever happens, including when the kill switch stops it, and
 * returns that row. Errors are logged in the row's note and then rethrown.
 */
function runDaily_(spreadsheet, client, steps) {
  const log = {ran_at: steps.now(), ingested: 'no', credits_used: 0, credits_remaining: '',
               leads: 0, emails_sent: 0, note: ''};
  const leadsBefore = loadLeads(spreadsheet).length;
  try {
    if (!outreachEnabled(spreadsheet)) {
      log.note = 'kill switch is not "yes": nothing done';
      return log;
    }
    steps.checkBounces();
    const guard = creditGuard_(client);
    log.credits_remaining = guard.remaining;
    let leads = [];
    if (guard.ok) {
      log.ingested = 'yes';
      leads = ingest_(spreadsheet, client, steps.today) || [];
    } else {
      log.note = guard.note;
    }
    log.emails_sent = steps.send(leads);
    return log;
  } catch (e) {
    log.note = [log.note, `error: ${e.message}`].filter(Boolean).join('; ');
    throw e;
  } finally {
    log.credits_used = client.creditsUsed;
    if (client.creditsRemaining !== null) log.credits_remaining = client.creditsRemaining;
    log.leads = loadLeads(spreadsheet).length - leadsBefore;
    appendRunLog(spreadsheet, log);
  }
}

/**
 * Whether ingestion may spend, from the free /usage endpoint: {ok, remaining, note}.
 * Fails closed: if the balance can't be read, ingestion is skipped.
 */
function creditGuard_(client) {
  let usage;
  try {
    usage = client.usage();
  } catch (e) {
    return {ok: false, remaining: '', note: `credit check failed, ingestion skipped: ${e.message}`};
  }
  if (usage.overLimit || usage.remaining < MIN_CREDITS_TO_RUN) {
    return {ok: false, remaining: usage.remaining,
            note: `${usage.remaining} credits left, under ${MIN_CREDITS_TO_RUN}: ingestion skipped`};
  }
  return {ok: true, remaining: usage.remaining, note: ''};
}

/**
 * Fetch new leads into the leads tab and return them, or return null without a single
 * Shovels call when the kill switch isn't "yes". Spends at most RUN_CREDIT_CAP credits.
 */
function ingest_(spreadsheet, client, today, states = US_STATES) {
  if (!outreachEnabled(spreadsheet)) {
    console.log('kill switch is not "yes": no Shovels calls');
    return null;
  }
  const searchLog = loadSearchLog(spreadsheet);
  let leads = [];
  try {
    leads = fetchLeads(client, states, {
      today: today,
      blocklist: loadBlocklist(spreadsheet),
      knownLeads: loadLeads(spreadsheet),
      searchLog: searchLog,
      targetLeads: 10,
      maxContractors: RUN_CREDIT_CAP,
    }).leads;
  } catch (e) {
    // Keep the leads found before the failure: they're already paid for.
    leads = (e.partial && e.partial.leads) || [];
    throw e;
  } finally {
    // Save even on failure so days and leads already paid for aren't fetched again.
    appendLeads(spreadsheet, leads);
    saveSearchLog(spreadsheet, searchLog);
    console.log(`wrote ${leads.length} leads; credits used: ${client.creditsUsed}, ` +
                `remaining: ${client.creditsRemaining}`);
  }
  return leads;
}

/** Replace the dailyRun triggers with one per weekday. Returns {removed, created}. */
function installTriggers_(scriptApp) {
  const removed = removeTriggers_(scriptApp);
  DAILY_RUN_DAYS.forEach(day => {
    scriptApp.newTrigger(DAILY_RUN_HANDLER).timeBased()
      .onWeekDay(scriptApp.WeekDay[day]).atHour(DAILY_RUN_HOUR).create();
  });
  return {removed, created: DAILY_RUN_DAYS.length};
}

/** Delete this project's dailyRun triggers, leaving any others. Returns how many. */
function removeTriggers_(scriptApp) {
  const ours = scriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === DAILY_RUN_HANDLER);
  ours.forEach(trigger => scriptApp.deleteTrigger(trigger));
  return ours.length;
}
