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

/**
 * LIVE: spends Shovels credits (1 per contractor returned, up to maxContractors).
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
  const searchLog = loadSearchLog(spreadsheet);
  let leads = [];
  try {
    leads = fetchLeads(client, US_STATES, {
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
}

/** UrlFetchApp in the shape ShovelsClient expects: {status, headers (lowercased), body}. */
function urlFetch_(url, headers) {
  const resp = UrlFetchApp.fetch(url, {headers: headers, muteHttpExceptions: true});
  const lower = {};
  const raw = resp.getAllHeaders();
  Object.keys(raw).forEach(name => { lower[name.toLowerCase()] = raw[name]; });
  return {status: resp.getResponseCode(), headers: lower, body: resp.getContentText()};
}
