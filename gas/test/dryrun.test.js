// Dry runs: the real pipeline against fakes, describing what it would do. These tests also
// guard the boundary that keeps the dry run current: every outside effect goes through the
// services object, so no stage can bypass the fakes.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {loadGas, assert} = require('./gas');
const {FakeSpreadsheetApp, FakeProperties} = require('./fakes');

const TODAY = '2026-11-16';
const clock = {today: () => TODAY, now: () => `${TODAY} 07:30`, print: () => {}};

test('dailyRun dry run: emails and Sheet rows are described, nothing real is touched', () => {
  const gas = loadGas();
  const report = gas.dryRunOnFakeSheet_('dailyRun', clock);
  assert.equal(report.error, null);
  assert.ok(report.emails.length > 0);
  report.emails.forEach(email => {
    assert.match(email.to, /fake/);
    assert.doesNotMatch(`${email.subject}\n${email.body}`, /\[[^\]]+\]|\{\w+\}/, 'every slot and placeholder filled');
  });
  assert.equal(report.result.emails_sent, report.emails.length);
  assert.ok(report.result.credits_used <= gas.RUN_CREDIT_CAP);
  const changes = report.sheetChanges.join('\n');
  assert.match(changes, /^leads:/m);
  assert.match(changes, /^ {2}\+ contractor_id=FAKE-/m);
  assert.match(changes, /^ {2}~ FAKE-OLD-2: email_success "" -> "no"/m, 'the fake bounce is caught');
  assert.match(changes, /^run_log:\n {2}\+ ran_at=2026-11-16 07:30, ingested=yes/m);
  assert.ok(report.actions.some(a => /Shovels \/contractors\/search .* would cost \d+ credits/.test(a)));
  // The real services don't exist in Node, so a stage calling one directly would have thrown.
  assert.throws(() => gas.GmailApp, /GmailApp is not defined/);
});

test('every DRY_RUN_ENTRIES entry point runs on the fake Sheet without error', () => {
  const gas = loadGas();
  Object.keys(gas.DRY_RUN_ENTRIES).forEach(name => {
    assert.equal(gas.dryRunOnFakeSheet_(name, clock).error, null, name);
  });
});

test('the source Sheet is only read: rows and kill switch unchanged, the copy pretends "yes"', () => {
  const gas = loadGas();
  const ss = gas.setupSheets(new FakeSpreadsheetApp(), new FakeProperties()).spreadsheet;
  ss.getSheetByName('template').getRange(2, 1, 1, 2).setValues([['Hi {company}', 'Fixtures for {state}.']]);
  const before = ss.sheets.map(sheet => [sheet.name, JSON.stringify(sheet.rows())]);

  const report = gas.runDry_(gas.DRY_RUN_ENTRIES.dailyRun, ss, clock);
  assert.equal(report.error, null);
  assert.ok(report.emails.length > 0);
  assert.match(report.notes.join('\n'), /kill switch is not "yes"/);
  assert.deepEqual(ss.sheets.map(sheet => [sheet.name, JSON.stringify(sheet.rows())]), before);
  assert.equal(gas.outreachEnabled(ss), false);
});

test('a run that would fail is reported, not thrown, with what it did before failing', () => {
  const gas = loadGas();
  const ss = gas.setupSheets(new FakeSpreadsheetApp(), new FakeProperties()).spreadsheet;  // template has [placeholders]
  const report = gas.runDry_(gas.DRY_RUN_ENTRIES.dailyRun, ss, clock);
  assert.match(report.error, /Fill in \[your name\]/);
  assert.equal(report.emails.length, 0);
  assert.match(report.sheetChanges.join('\n'), /run_log:\n.*note=error: Fill in/);
});

test('a call to a host with no fake is refused and reported, even if the code swallows the error', () => {
  const gas = loadGas();
  const report = gas.dryRunOnFakeSheet_('dailyRun', Object.assign({}, clock));
  assert.deepEqual(report.notes, []);
  const swallowed = gas.runDry_(services => {
    try { services.fetch('https://api.example.org/new-thing', {}); } catch (e) { /* swallowed */ }
  }, gas.fakeSpreadsheet_(TODAY).spreadsheet, clock);
  assert.match(swallowed.notes.join('\n'), /Unfaked outside call: dry run: no fake for api\.example\.org/);
});

test('Sheet writes are described by column name, and the net diff pairs updated rows', () => {
  const gas = loadGas();
  const header = ['contractor_id', 'emailed_at', 'email'];
  const add = gas.describeWrite_({tab: 'leads', row: 5, col: 1, before: [['', '', '']], after: [['C1', '', 'a@b.co']]},
                                 header, () => 'C1');
  assert.equal(add, 'Sheet leads: add row 5: contractor_id=C1, email=a@b.co');
  const update = gas.describeWrite_({tab: 'leads', row: 5, col: 2, before: [['']], after: [['2026-11-16']]},
                                    header, () => 'C1');
  assert.equal(update, 'Sheet leads: row 5 (C1): emailed_at "" -> "2026-11-16"');
  assert.equal(gas.describeWrite_({tab: 'leads', row: 5, col: 2, before: [['x']], after: [['x']]}, header, () => ''), null);

  const diff = gas.diffSheets_(
    {leads: {header, rows: [['C1', '', 'a@b.co'], ['C2', '', 'c@d.co']]}},
    {leads: {header, rows: [['C1', 'today', 'a@b.co'], ['C2', '', 'c@d.co'], ['C3', '', 'e@f.co']]},
     run_log: {header: ['ran_at'], rows: [['now']]}});
  assert.deepEqual(diff, ['leads:', '  ~ C1: emailed_at "" -> "today"', '  + contractor_id=C3, email=e@f.co',
                          'run_log (new tab):', '  + ran_at=now']);
});

test('only main.js touches real Google services, so the dry run\'s fakes cover every stage', () => {
  const SRC = path.join(__dirname, '..', 'src');
  const services = /\b(GmailApp|MailApp|UrlFetchApp|SpreadsheetApp|DriveApp|CalendarApp|PropertiesService|LockService|ScriptApp|HtmlService|CacheService|Session)\b/;
  const offenders = fs.readdirSync(SRC, {recursive: true}).map(f => f.split(path.sep).join('/'))
    .filter(f => f.endsWith('.js') && f !== 'main.js')
    .filter(f => {
      const code = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      return services.test(code);
    });
  assert.deepEqual(offenders, [], 'pass the service in through liveServices_ instead');
});
