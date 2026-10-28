/**
 * Entry points run from the Apps Script editor (and later by triggers). These are the only
 * functions that touch the real Google services; everything they call takes the services
 * as arguments so the Node tests can pass fakes.
 */

/** Create the spreadsheet if needed and add any missing tabs and columns. Safe to rerun. */
function setup() {
  const result = setupSheets(SpreadsheetApp, PropertiesService.getScriptProperties());
  console.log(result.changes.length ? result.changes.join('\n') : 'already up to date');
  console.log(`spreadsheet: ${result.spreadsheet.getUrl()}`);
}

// Most emails one run sends: today's new leads plus a backlog of unsent rows.
const MAX_EMAILS_PER_RUN = 20;

/**
 * LIVE: if the kill switch says "yes", spends Shovels credits (1 per contractor returned,
 * up to maxContractors), then emails the new leads (and any unsent ones).
 * Only run it with the user's approval. Don't put it on a trigger until the credit guard
 * exists (see the hard rules in CLAUDE.md).
 */
function runIngestion() {
  const properties = PropertiesService.getScriptProperties();
  const apiKey = properties.getProperty('SHOVELS_API_KEY');
  if (!apiKey) throw new Error('Set the SHOVELS_API_KEY script property first.');
  const spreadsheet = openSpreadsheet(SpreadsheetApp, properties);
  const client = new ShovelsClient(apiKey, urlFetch_, ms => Utilities.sleep(ms));
  const today = Utilities.formatDate(new Date(), spreadsheet.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  const leads = ingest_(spreadsheet, client, today);
  if (leads) sendPending_(spreadsheet, leads);
}

/**
 * Fetch new leads into the leads tab and return them, or return null without a single
 * Shovels call when the kill switch isn't "yes". Takes no Google services, so tests can run it.
 */
function ingest_(spreadsheet, client, today, states = US_STATES) {
  if (!outreachEnabled(spreadsheet)) {
    console.log('kill switch is not "yes": no Shovels calls, no emails sent');
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
      maxContractors: 50,
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

/** LIVE: emails every lead in the leads tab with a blank emailed_at. No Shovels calls. */
function sendPendingEmails() {
  sendPending_(openSpreadsheet(SpreadsheetApp, PropertiesService.getScriptProperties()), []);
}

/**
 * Send the template, filled for a sample California lead, to your own address so you can
 * see what leads get. Works while [placeholders] are still unfilled; ignores the kill switch.
 */
function sendTestEmail() {
  const spreadsheet = openSpreadsheet(SpreadsheetApp, PropertiesService.getScriptProperties());
  const email = fillTemplate(loadTemplate(spreadsheet),
                             {name: 'SAMPLE ELECTRIC INC', state: 'CA', city: 'FRESNO', project_type: 'remodel'});
  const me = Session.getEffectiveUser().getEmail();
  gmailSend_(me, `[TEST] ${email.subject}`, email.body);
  console.log(`sent a test email to ${me}`);
}

/**
 * Search Gmail for bounce notices from the last 30 days and fill in email_success on the
 * leads tab: "no" for leads whose email bounced, "yes" for the other emailed leads. Reads
 * Gmail only and sends nothing, so it ignores the kill switch. Sending runs it first too.
 */
function checkBounces() {
  checkBounces_(openSpreadsheet(SpreadsheetApp, PropertiesService.getScriptProperties()));
}

function checkBounces_(spreadsheet) {
  const messages = GmailApp.search(BOUNCE_QUERY, 0, 100).flatMap(thread => thread.getMessages().map(m => ({
    threadId: thread.getId(), from: m.getFrom(), subject: m.getSubject(),
    failedRecipients: m.getHeader('X-Failed-Recipients'), body: m.getPlainBody(),
  })));
  const result = findBounces(loadLeads(spreadsheet), messages);
  result.bounced.forEach(id => updateLead(spreadsheet, id, {email_success: 'no'}));
  result.delivered.forEach(id => updateLead(spreadsheet, id, {email_success: 'yes'}));
  console.log(`bounces: ${result.bounced.length ? result.bounced.join(', ') : 'none new'}; ` +
              `marked delivered: ${result.delivered.length}`);
}

/** Email pending leads, marking each row as soon as its email goes out. freshLeads fill the slots. */
function sendPending_(spreadsheet, freshLeads) {
  if (!outreachEnabled(spreadsheet)) {
    console.log('kill switch is not "yes": no emails sent');
    return;
  }
  checkBounces_(spreadsheet);  // catches the last run's bounces
  const tz = spreadsheet.getSpreadsheetTimeZone();
  const result = sendEmails(pendingLeads(loadLeads(spreadsheet), freshLeads), loadTemplate(spreadsheet),
                            loadBlocklist(spreadsheet), gmailSend_, {
    now: () => Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'),
    maxEmails: MAX_EMAILS_PER_RUN,
    onSent: sent => markEmailed(spreadsheet, sent.contractor_id, sent.emailed_at, sent.thread_id),
    mailServer: domain => hasMailServer(urlFetch_, domain),
    onUndeliverable: id => updateLead(spreadsheet, id, {email_success: 'no'}),
  });
  console.log(`sent ${result.sent.length} emails` +
              (result.blocked.length ? `; blocklisted, not sent: ${result.blocked.join(', ')}` : '') +
              (result.undeliverable.length ? `; no mail server, not sent: ${result.undeliverable.join(', ')}` : ''));
}

/** Send a plain-text email and return its Gmail thread ID (sendEmail() returns nothing). */
function gmailSend_(to, subject, body) {
  return GmailApp.createDraft(to, subject, body).send().getThread().getId();
}

/** UrlFetchApp in the shape ShovelsClient expects: {status, headers (lowercased), body}. */
function urlFetch_(url, headers) {
  const resp = UrlFetchApp.fetch(url, {headers: headers, muteHttpExceptions: true});
  const lower = {};
  const raw = resp.getAllHeaders();
  Object.keys(raw).forEach(name => { lower[name.toLowerCase()] = raw[name]; });
  return {status: resp.getResponseCode(), headers: lower, body: resp.getContentText()};
}
