// setupSheets() and the store against an in-memory SpreadsheetApp (no Google calls).
const test = require('node:test');
const {loadGas, plain, assert} = require('./gas');
const {FakeSpreadsheetApp, FakeProperties, FakeShovels} = require('./fakes');

function fresh() {
  const gas = loadGas();
  const app = new FakeSpreadsheetApp();
  const props = new FakeProperties();
  const setup = () => gas.setupSheets(app, props);
  return {gas, app, props, setup};
}

test('first run creates the spreadsheet, every tab and its header', () => {
  const {gas, app, props, setup} = fresh();
  const {spreadsheet, created} = setup();

  assert.equal(created, true);
  assert.equal(props.getProperty('SPREADSHEET_ID'), spreadsheet.getId());
  assert.equal(Object.keys(app.files).length, 1);
  assert.deepEqual(spreadsheet.getSheets().map(s => s.getName()), Object.keys(gas.SCHEMA));  // no "Sheet1"
  for (const [name, tab] of Object.entries(gas.SCHEMA)) {
    const sheet = spreadsheet.getSheetByName(name);
    assert.deepEqual(sheet.rows()[0], tab.columns);
    assert.equal(sheet.frozenRows, 1);
  }
});

test('blocklist is seeded once, with both lists side by side', () => {
  const {gas, setup} = fresh();
  const sheet = setup().spreadsheet.getSheetByName('blocklist');
  const {seed} = gas.SCHEMA.blocklist;
  assert.equal(sheet.getLastRow(), 1 + Math.max(seed.company.length, seed.email_domain.length));
  assert.deepEqual(sheet.rows()[1], [seed.company[0], seed.email_domain[0]]);
  assert.deepEqual(plain(gas.loadBlocklist(sheet.getParent()).emailDomains.size), seed.email_domain.length);
});

test('kill switch starts off: "no" in A2 under the question', () => {
  const {setup} = fresh();
  const sheet = setup().spreadsheet.getSheetByName('kill_switch');
  assert.deepEqual(sheet.rows(), [['Continue automatic outreach?'], ['no']]);
});

test('rerunning changes nothing and keeps data, including hand edits', () => {
  const {app, setup} = fresh();
  const ss = setup().spreadsheet;
  const blocklist = ss.getSheetByName('blocklist');
  blocklist.getRange(2, 1).setValues([['Hand Added Co']]);
  blocklist.getRange(blocklist.getLastRow() + 1, 2).setValues([['spam.example']]);
  ss.getSheetByName('leads').getRange(2, 1, 1, 3).setValues([['C01', '', 'Shop 1']]);
  const before = ss.getSheets().map(s => plain(s.rows()));

  const again = setup();

  assert.equal(again.created, false);
  assert.deepEqual(again.changes, []);
  assert.equal(again.spreadsheet, ss);
  assert.equal(Object.keys(app.files).length, 1);
  assert.deepEqual(ss.getSheets().map(s => plain(s.rows())), before);
});

test('a column added to the schema is appended without moving existing data', () => {
  const {gas, setup} = fresh();
  const ss = setup().spreadsheet;
  const leads = ss.getSheetByName('leads');
  leads.getRange(2, 1, 1, 3).setValues([['C01', 'Shop 1', 'x1@shop1.com']]);
  gas.SCHEMA.leads.columns.push('thread_id');

  const {changes} = setup();

  assert.deepEqual(changes, ['added columns to leads: thread_id']);
  assert.equal(leads.rows()[0].at(-1), 'thread_id');
  assert.deepEqual(leads.rows()[1].slice(0, 3), ['C01', 'Shop 1', 'x1@shop1.com']);
});

test('a deleted tab is recreated and the others are left alone', () => {
  const {setup} = fresh();
  const ss = setup().spreadsheet;
  ss.deleteSheet(ss.getSheetByName('search_log'));
  const {changes} = setup();
  assert.deepEqual(changes, ['created tab search_log']);
});

test('a spreadsheet ID that no longer opens is an error, not a second spreadsheet', () => {
  const {app, props, setup} = fresh();
  props.setProperty('SPREADSHEET_ID', 'gone');
  assert.throws(setup, /Can't open spreadsheet gone/);
  assert.equal(Object.keys(app.files).length, 0);
});

test('store needs setup first', () => {
  const {gas, app, props} = fresh();
  assert.throws(() => gas.openSpreadsheet(app, props), /run setup\(\) first/);
});

test('leads round-trip by header name, even after columns are moved by hand', () => {
  const {gas, setup} = fresh();
  const ss = setup().spreadsheet;
  const sheet = ss.getSheetByName('leads');
  // Swap the first two header cells, as someone rearranging the Sheet might.
  sheet.getRange(1, 1, 1, 2).setValues([['emailed_at', 'contractor_id']]);
  // Leads carry extra fields for the template; only the schema's columns are written.
  gas.appendLeads(ss, [{contractor_id: 'C01', name: 'Shop 1', email: 'x1@shop1.com', city: 'BESSEMER',
                        project_type: 'remodel', emailed_at: '2026-10-21T09:00:00'},
                       {contractor_id: 'C02', name: 'Shop 2', email: 'x2@shop2.com'}]);

  assert.deepEqual(sheet.rows()[0], ['emailed_at', 'contractor_id', 'name', 'email']);
  assert.deepEqual(sheet.rows()[1], ['2026-10-21T09:00:00', 'C01', 'Shop 1', 'x1@shop1.com']);
  assert.ok(sheet.formats.every(f => f.format === '@'));  // plain text: no date or number guessing
  assert.deepEqual(gas.loadLeads(ss), [
    {emailed_at: '2026-10-21T09:00:00', contractor_id: 'C01', name: 'Shop 1', email: 'x1@shop1.com'},
    {emailed_at: '', contractor_id: 'C02', name: 'Shop 2', email: 'x2@shop2.com'},
  ]);
});

test('appending grows the sheet when it runs out of rows', () => {
  const {gas, setup} = fresh();
  const ss = setup().spreadsheet;
  const sheet = ss.getSheetByName('leads');
  sheet.maxRows = 2;
  gas.appendLeads(ss, [{contractor_id: 'A'}, {contractor_id: 'B'}, {contractor_id: 'C'}]);
  assert.deepEqual(gas.loadLeads(ss).map(r => r.contractor_id), ['A', 'B', 'C']);
});

test('dates typed into the Sheet read back as YYYY-MM-DD', () => {
  const {gas, setup} = fresh();
  const ss = setup().spreadsheet;
  ss.getSheetByName('search_log').getRange(2, 1, 1, 4)
    .setValues([['CA', new Date('2026-10-05T00:00:00Z'), '2026-10-06', '2026-10-21']]);
  assert.deepEqual(plain(gas.loadSearchLog(ss)), {CA: {last_searched: '2026-10-21', days: ['2026-10-05', '2026-10-06']}});
});

test('search log is stored as merged date ranges and read back as days', () => {
  const {gas, setup} = fresh();
  const ss = setup().spreadsheet;
  const log = {
    CA: {last_searched: '2026-10-21', days: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-09', '2026-10-10']},
    WY: {last_searched: '2026-10-20', days: []},
  };
  gas.saveSearchLog(ss, log);

  assert.deepEqual(ss.getSheetByName('search_log').rows(), [
    ['state', 'start', 'end', 'searched_at'],
    ['CA', '2026-10-09', '2026-10-10', '2026-10-21'],
    ['CA', '2026-10-05', '2026-10-07', '2026-10-21'],
    ['WY', '', '', '2026-10-20'],
  ]);
  assert.deepEqual(plain(gas.loadSearchLog(ss)), log);

  // Saving a shorter log leaves no stale rows behind.
  gas.saveSearchLog(ss, {CA: {last_searched: '2026-10-22', days: ['2026-10-10']}});
  assert.equal(ss.getSheetByName('search_log').getLastRow(), 2);
});

test('ranges merge across month ends', () => {
  const {gas} = fresh();
  assert.deepEqual(plain(gas.toRanges(['2026-10-01', '2026-09-30', '2026-09-29', '2026-09-27'])),
                   [['2026-09-27', '2026-09-27'], ['2026-09-29', '2026-10-01']]);
  assert.deepEqual(plain(gas.expandRange('2026-09-30', '2026-10-01')), ['2026-09-30', '2026-10-01']);
});

test('two runs through the Sheet: the leads tab stops repeat contacts', () => {
  const {gas, app, props, setup} = fresh();
  setup();
  const api = new FakeShovels();
  const run = () => {
    const ss = gas.openSpreadsheet(app, props);
    const searchLog = gas.loadSearchLog(ss);
    const {leads} = gas.fetchLeads(new gas.ShovelsClient('k', api.fetch), ['CA'], {
      today: '2026-10-21', blocklist: gas.loadBlocklist(ss), knownLeads: gas.loadLeads(ss),
      searchLog, targetLeads: 3,
    });
    gas.appendLeads(ss, leads);
    gas.saveSearchLog(ss, searchLog);
    return leads.map(l => l.contractor_id);
  };

  assert.deepEqual(run(), ['C01', 'C07', 'C08']);
  assert.deepEqual(run(), ['C09', 'C10', 'C11']);  // C01 turns up again on 10-10 and is skipped
  const ss = gas.openSpreadsheet(app, props);
  assert.deepEqual(gas.loadLeads(ss).map(r => r.contractor_id), ['C01', 'C07', 'C08', 'C09', 'C10', 'C11']);
  assert.deepEqual(ss.getSheetByName('search_log').rows().slice(1), [['CA', '2026-10-10', '2026-10-11', '2026-10-21']]);
});
