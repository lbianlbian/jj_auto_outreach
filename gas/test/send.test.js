// Template filling and sending, with a fake mailer and an in-memory Sheet (no Gmail calls).
const test = require('node:test');
const {loadGas, assert} = require('./gas');
const {FakeSpreadsheetApp, FakeProperties} = require('./fakes');

const TEMPLATE = {subject: 'Fixtures for {state}', body: 'Hi {company} in {city}, {project_type} job in {state}.'};

function fresh() {
  const gas = loadGas();
  const ss = gas.setupSheets(new FakeSpreadsheetApp(), new FakeProperties()).spreadsheet;
  const seed = gas.SCHEMA.blocklist.seed;
  const blocklist = new gas.Blocklist(seed.company, seed.email_domain);
  const outbox = [];
  const mailer = (to, subject, body) => {
    outbox.push({to, subject, body});
    return `thread-${outbox.length}`;
  };
  let minute = 0;
  const send = (leads, options = {}) => gas.sendEmails(leads, TEMPLATE, blocklist, mailer, {
    now: () => `2026-10-27 09:0${minute++}`, maxEmails: 20, ...options,
  });
  return {gas, ss, blocklist, outbox, mailer, send};
}

const lead = (id, extra = {}) => ({contractor_id: id, name: `Shop ${id}`, email: `${id.toLowerCase()}@shop.com`, ...extra});

test('slots are filled from the lead, with the permit state spelled out', () => {
  const {gas} = fresh();
  const email = gas.fillTemplate(TEMPLATE, lead('C01', {state: 'CA', city: 'SAN LUIS OBISPO', project_type: 'remodel'}));
  assert.deepEqual(email, {subject: 'Fixtures for California',
                           body: 'Hi Shop C01 in San Luis Obispo, remodel job in California.'});
});

test('missing fields fall back to generic wording', () => {
  const {gas} = fresh();
  const email = gas.fillTemplate(TEMPLATE, {contractor_id: 'C01', email: 'a@b.com'});
  assert.equal(email.body, 'Hi your company in your area, electrical job in your area.');
});

test('the seeded template mentions the permit state and leaves name and address to fill in', () => {
  const {gas, ss} = fresh();
  const template = gas.loadTemplate(ss);
  assert.match(template.subject, /\{state\}/);
  assert.match(template.body, /electrical permit in \{state\}/);
  assert.match(template.body, /https:\/\/www\.jojospring\.com/);
  assert.match(template.body, /no thanks/);  // CAN-SPAM opt-out
  assert.throws(() => gas.checkTemplate(template), /Fill in \[your name\], \[mailing address\]/);
});

test('an unfilled placeholder or unknown slot sends nothing', () => {
  const {gas, blocklist, outbox, mailer} = fresh();
  const opts = {now: () => 'now', maxEmails: 20};
  for (const [template, error] of [
    [{subject: 'Hi', body: 'From [your name]'}, /Fill in \[your name\]/],
    [{subject: 'Hi {State}', body: 'x'}, /Unknown slot \{State\}/],
  ]) {
    assert.throws(() => gas.sendEmails([lead('C01')], template, blocklist, mailer, opts), error);
  }
  assert.equal(outbox.length, 0);
});

test('sends each pending lead once and reports thread IDs', () => {
  const {send, outbox} = fresh();
  const marked = [];
  const result = send([lead('C01', {state: 'TX'}), lead('C02', {emailed_at: '2026-10-20 10:00'}), lead('C03')],
                      {onSent: sent => marked.push(sent)});

  assert.deepEqual(outbox.map(m => [m.to, m.subject]), [['c01@shop.com', 'Fixtures for Texas'],
                                                        ['c03@shop.com', 'Fixtures for your area']]);
  assert.deepEqual(result.sent, [
    {contractor_id: 'C01', emailed_at: '2026-10-27 09:00', thread_id: 'thread-1'},
    {contractor_id: 'C03', emailed_at: '2026-10-27 09:01', thread_id: 'thread-2'},
  ]);
  assert.deepEqual(marked, result.sent);
});

test('maxEmails caps a run', () => {
  const {send, outbox} = fresh();
  send([lead('C01'), lead('C02'), lead('C03')], {maxEmails: 2});
  assert.equal(outbox.length, 2);
});

test('a lead blocklisted after it was found is not emailed', () => {
  const {send, outbox} = fresh();
  const result = send([lead('C01', {name: 'SUNRUN INSTALL CO'}), lead('C02', {email: 'x@ipermitca.com'}), lead('C03')]);
  assert.deepEqual(result.blocked, ['C01', 'C02']);
  assert.deepEqual(outbox.map(m => m.to), ['c03@shop.com']);
});

test('pending leads are the unsent rows, filled in from this run where possible', () => {
  const {gas} = fresh();
  const rows = [
    {contractor_id: 'C01', name: 'Shop 1', email: 'a@1.com', emailed_at: '2026-10-20 10:00', thread_id: 't'},
    {contractor_id: 'C02', name: 'Shop 2', email: 'a@2.com', emailed_at: '', thread_id: ''},  // earlier run
    {contractor_id: 'C03', name: 'Shop 3', email: 'a@3.com', emailed_at: '', thread_id: ''},  // this run
  ];
  const pending = gas.pendingLeads(rows, [{contractor_id: 'C03', state: 'OH', city: 'DAYTON', emailed_at: ''}]);
  assert.deepEqual(pending.map(l => [l.contractor_id, l.state]), [['C02', undefined], ['C03', 'OH']]);
});

test('through the Sheet: sent rows are marked and a second run sends nothing', () => {
  const {gas, ss, send, outbox} = fresh();
  const sheet = ss.getSheetByName('leads');
  gas.appendLeads(ss, [lead('C01'), lead('C02'), lead('C03')]);
  sheet.getRange(3, 1, 1, 7).setValues([['', '', '', '', '', '', '']]);  // a blank row someone left in the middle
  const run = () => send(gas.pendingLeads(gas.loadLeads(ss), []), {
    onSent: s => gas.markEmailed(ss, s.contractor_id, s.emailed_at, s.thread_id),
  });

  run();
  run();

  assert.equal(outbox.length, 2);
  assert.deepEqual(sheet.rows().slice(1), [
    ['C01', '2026-10-27 09:00', 'Shop C01', 'thread-1', '', '', 'c01@shop.com'],
    ['', '', '', '', '', '', ''],
    ['C03', '2026-10-27 09:01', 'Shop C03', 'thread-2', '', '', 'c03@shop.com'],
  ]);
});

test('kill switch: only "yes" lets outreach run', () => {
  const {gas, ss} = fresh();
  const cell = ss.getSheetByName('kill_switch').getRange(2, 1);
  assert.equal(gas.outreachEnabled(ss), false);  // seeded "no"
  for (const [value, enabled] of [[' Yes ', true], ['yes', true], ['', false], ['y', false], ['stop', false]]) {
    cell.setValues([[value]]);
    assert.equal(gas.outreachEnabled(ss), enabled, `"${value}"`);
  }
});
