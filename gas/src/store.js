/**
 * All Sheet access: leads, search log and blocklist, so the rest of the code never
 * knows where data lives. Columns are found by header name (see
 * schema.js), not position, and every value is read and written as plain text.
 */

/** The spreadsheet setup() created. Throws if setup() hasn't been run yet. */
function openSpreadsheet(spreadsheetApp, properties) {
  const id = properties.getProperty(SPREADSHEET_ID_PROPERTY);
  if (!id) throw new Error('No spreadsheet yet: run setup() first.');
  return spreadsheetApp.openById(id);
}

function loadBlocklist(spreadsheet) {
  const rows = readRows_(sheet_(spreadsheet, 'blocklist'));
  return new Blocklist(rows.map(r => r.company).filter(Boolean),
                       rows.map(r => r.email_domain).filter(Boolean));
}

/** Every lead found so far, as {contractor_id, email, ...} keyed by column name. */
function loadLeads(spreadsheet) {
  return readRows_(sheet_(spreadsheet, 'leads'));
}

/** Add leads (from fetchLeads) to the bottom of the leads tab; emailed_at is blank until set. */
function appendLeads(spreadsheet, leads) {
  const sheet = sheet_(spreadsheet, 'leads');
  const rows = leads.map(lead => ({
    contractor_id: lead.contractor_id, name: lead.name, email: lead.email, emailed_at: lead.emailed_at || '',
  }));
  writeRows_(sheet, sheet.getLastRow() + 1, rows);
}

/** Return {state: {last_searched, days: [searched days]}}, the shape fetchLeads uses. */
function loadSearchLog(spreadsheet) {
  const log = {};
  readRows_(sheet_(spreadsheet, 'search_log')).forEach(row => {
    if (!row.state) return;
    const entry = log[row.state] = log[row.state] || {last_searched: '', days: []};
    if (row.searched_at > entry.last_searched) entry.last_searched = row.searched_at;
    if (row.start && row.end) entry.days.push(...expandRange(row.start, row.end));
  });
  Object.keys(log).forEach(state => { log[state].days = [...new Set(log[state].days)].sort(); });
  return log;
}

/** Rewrite the search_log tab from fetchLeads' search log, one row per run of consecutive days. */
function saveSearchLog(spreadsheet, searchLog) {
  const sheet = sheet_(spreadsheet, 'search_log');
  const rows = [];
  Object.keys(searchLog).sort().forEach(state => {
    const entry = searchLog[state];
    const ranges = toRanges(entry.days || []).reverse();  // newest first reads better
    if (!ranges.length) ranges.push(['', '']);  // keeps searched_at for a state with no data
    ranges.forEach(([start, end]) => rows.push({state, start, end, searched_at: entry.last_searched}));
  });
  const width = readHeader(sheet).length;
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, width).clearContent();
  writeRows_(sheet, 2, rows);
}

/** Sorted days -> [[start, end], ...] inclusive ranges of consecutive days, oldest first. */
function toRanges(days) {
  const ranges = [];
  [...new Set(days)].sort().forEach(day => {
    const last = ranges[ranges.length - 1];
    if (last && addDays(last[1], 1) === day) last[1] = day;
    else ranges.push([day, day]);
  });
  return ranges;
}

/** Every day from start to end, inclusive. */
function expandRange(start, end) {
  const days = [];
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
  return days;
}

function sheet_(spreadsheet, name) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error(`No "${name}" tab: run setup() first.`);
  return sheet;
}

/** Data rows as objects keyed by header name, every value a trimmed string. */
function readRows_(sheet) {
  const header = readHeader(sheet);
  const height = sheet.getLastRow() - 1;
  if (!header.length || height < 1) return [];
  const tz = sheet.getParent().getSpreadsheetTimeZone();
  return sheet.getRange(2, 1, height, header.length).getValues()
    .filter(values => values.some(v => v !== ''))
    .map(values => {
      const row = {};
      header.forEach((name, i) => { if (name) row[name] = cellText_(values[i], tz); });
      return row;
    });
}

/** Write row objects starting at startRow, each value under its header's column, as plain text. */
function writeRows_(sheet, startRow, rows) {
  if (!rows.length) return;
  const header = readHeader(sheet);
  const missing = Object.keys(rows[0]).filter(name => header.indexOf(name) === -1);
  if (missing.length) {
    throw new Error(`"${sheet.getName()}" tab has no column ${missing.join(', ')}: run setup() first.`);
  }
  const lastRow = startRow + rows.length - 1;
  if (lastRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), lastRow - sheet.getMaxRows());
  const values = rows.map(row => header.map(name => (row[name] === undefined || row[name] === null)
    ? '' : String(row[name])));
  // Plain text, so Sheets doesn't turn dates into Date objects or phone numbers into numbers.
  sheet.getRange(startRow, 1, rows.length, header.length).setNumberFormat('@').setValues(values);
}

/** A cell as a string. Dates someone typed into the Sheet come back as Date objects. */
function cellText_(value, tz) {
  if (value instanceof Date || Object.prototype.toString.call(value) === '[object Date]') {
    return typeof Utilities !== 'undefined'
      ? Utilities.formatDate(value, tz, 'yyyy-MM-dd') : value.toISOString().slice(0, 10);
  }
  return String(value).trim();
}
