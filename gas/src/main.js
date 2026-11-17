/**
 * Entry points run from the Apps Script editor or by triggers. These are the only
 * functions that touch the real Google services; everything they call takes the services
 * as arguments (see liveServices_) so the Node tests and dryRun() can pass fakes.
 */

/**
 * Create the spreadsheet if needed and add any missing tabs and columns, make the
 * dashboard key if there isn't one, and log both links. Safe to rerun.
 */
function setup() {
  const properties = PropertiesService.getScriptProperties();
  const result = setupSheets(SpreadsheetApp, properties);
  console.log(result.changes.length ? result.changes.join('\n') : 'already up to date');
  console.log(`spreadsheet: ${result.spreadsheet.getUrl()}`);
  logDashboardLink_(ensureDashboardKey(properties, () => Utilities.getUuid()));
}

/** Replace the dashboard key: every link shared so far stops working. Logs the new link. */
function resetDashboardKey() {
  const key = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty(DASHBOARD_KEY_PROPERTY, key);
  logDashboardLink_(key);
}

function logDashboardLink_(key) {
  const url = ScriptApp.getService().getUrl();
  console.log(url ? `dashboard (anyone with this link can view): ${url}?key=${key}`
                  : 'dashboard: no web app deployment yet, so no link');
}

/**
 * LIVE: what the weekday trigger runs (see setupTriggers), and the way to run ingestion by
 * hand. If the kill switch says "yes": checks bounces, spends up to RUN_CREDIT_CAP Shovels
 * credits when the free /usage check shows at least MIN_CREDITS_TO_RUN left, then emails
 * the new leads and any unsent ones. Every run, even a skipped one, gets a run_log row.
 * dryRun() runs the same code against fakes.
 */
function dailyRun() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('another run is still going: skipped');
    return;
  }
  try {
    console.log(JSON.stringify(dailyRunWith_(liveServices_())));
  } finally {
    lock.releaseLock();
  }
}

/**
 * FREE, SAFE: dailyRun() with fake Shovels, DNS and Gmail and an in-memory copy of the
 * Sheet. Logs every action the real run would take: each Shovels call and its credit
 * cost, each email in full, each Sheet write, then the net change to every tab. Sends
 * nothing, writes nothing to the real Sheet and spends no credits. If the kill switch
 * isn't "yes", the copy pretends it is (and says so) so there is something to show.
 */
function dryRun() {
  const live = liveServices_();
  runDry_(DRY_RUN_ENTRIES.dailyRun, live.spreadsheet, {today: live.today, now: live.now});
}

/**
 * Schedule dailyRun() for weekdays between 7 and 8am in the script's time zone. Replaces
 * any dailyRun triggers already there, so rerunning it never doubles them up.
 */
function setupTriggers() {
  const result = installTriggers_(ScriptApp);
  console.log(`removed ${result.removed} old trigger(s), created ${result.created}: ` +
              `dailyRun() on weekdays at ${DAILY_RUN_HOUR}-${DAILY_RUN_HOUR + 1}h`);
}

/** Delete the dailyRun triggers. The kill switch also stops runs without touching triggers. */
function removeTriggers() {
  console.log(`removed ${removeTriggers_(ScriptApp)} trigger(s)`);
}

/**
 * The web app: the read-only dashboard (dashboard.js). Deployed for "Anyone, even
 * anonymous", so it shows only when the URL has the right ?key= (setup() logs the link).
 * Reads the Sheet only: no Shovels calls, no email.
 */
function doGet(e) {
  const properties = PropertiesService.getScriptProperties();
  if (!dashboardKeyMatches(e && e.parameter, properties)) {
    return HtmlService.createHtmlOutput('<!doctype html><p>Not found.</p>').setTitle('Not found');
  }
  let html;
  try {
    const spreadsheet = openSpreadsheet(SpreadsheetApp, properties);
    const today = Utilities.formatDate(new Date(), spreadsheet.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
    html = renderDashboard(dashboardData(spreadsheet, today));
  } catch (e) {
    html = `<!doctype html><p>The dashboard couldn't load: ${escapeHtml_(e.message)}</p>`;
  }
  return HtmlService.createHtmlOutput(html)
    .setTitle('JoJoSpring outreach')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** LIVE: emails every lead in the leads tab with a blank emailed_at. No Shovels calls. */
function sendPendingEmails() {
  sendPending_(liveServices_(), []);
}

/**
 * Send the template, filled for a sample California lead, to your own address so you can
 * see what leads get. Works while [placeholders] are still unfilled; ignores the kill switch.
 */
function sendTestEmail() {
  const services = liveServices_();
  const email = fillTemplate(loadTemplate(services.spreadsheet),
                             {name: 'SAMPLE ELECTRIC INC', state: 'CA', city: 'FRESNO', project_type: 'remodel'});
  const me = Session.getEffectiveUser().getEmail();
  services.sendMail(me, `[TEST] ${email.subject}`, email.body);
  console.log(`sent a test email to ${me}`);
}

/**
 * Search Gmail for bounce notices from the last 30 days and fill in email_success on the
 * leads tab: "no" for leads whose email bounced, "yes" for the other emailed leads. Reads
 * Gmail only and sends nothing, so it ignores the kill switch. Sending runs it first too.
 */
function checkBounces() {
  checkBounces_(liveServices_());
}

/**
 * The real outside world, as the pipeline sees it. Every effect outside this script goes
 * through one of these, so dryRun() can swap in fakes (src/dryrun/) while the pipeline
 * code stays the same. A new kind of effect (another API, Slack, a calendar) gets a key
 * here and a fake in dryrun/services.js, never a direct GmailApp or UrlFetchApp call
 * elsewhere (test/dryrun.test.js checks that).
 *   spreadsheet                    the Sheet, read and written only through store.js
 *   fetch(url, headers)            all HTTP (Shovels, DNS): {status, headers, body}
 *   sleep(ms)
 *   today(), now()                 'yyyy-MM-dd' and 'yyyy-MM-dd HH:mm', Sheet time zone
 *   sendMail(to, subject, body)    sends one email, returns its Gmail thread ID
 *   searchMail(query, max)         [{threadId, from, subject, failedRecipients, body}]
 *   shovelsApiKey
 */
function liveServices_() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheet = openSpreadsheet(SpreadsheetApp, properties);
  const tz = spreadsheet.getSpreadsheetTimeZone();
  return {
    spreadsheet: spreadsheet,
    fetch: urlFetch_,
    sleep: ms => Utilities.sleep(ms),
    today: () => Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'),
    now: () => Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'),
    sendMail: gmailSend_,
    searchMail: gmailSearch_,
    shovelsApiKey: properties.getProperty('SHOVELS_API_KEY'),
  };
}

/** Send a plain-text email and return its Gmail thread ID (sendEmail() returns nothing). */
function gmailSend_(to, subject, body) {
  return GmailApp.createDraft(to, subject, body).send().getThread().getId();
}

/** Every message in the first `max` threads matching a Gmail search. */
function gmailSearch_(query, max) {
  return GmailApp.search(query, 0, max).flatMap(thread => thread.getMessages().map(m => ({
    threadId: thread.getId(), from: m.getFrom(), subject: m.getSubject(),
    failedRecipients: m.getHeader('X-Failed-Recipients'), body: m.getPlainBody(),
  })));
}

/** UrlFetchApp in the shape ShovelsClient expects: {status, headers (lowercased), body}. */
function urlFetch_(url, headers) {
  const resp = UrlFetchApp.fetch(url, {headers: headers, muteHttpExceptions: true});
  const lower = {};
  const raw = resp.getAllHeaders();
  Object.keys(raw).forEach(name => { lower[name.toLowerCase()] = raw[name]; });
  return {status: resp.getResponseCode(), headers: lower, body: resp.getContentText()};
}
