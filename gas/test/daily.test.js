// The daily run end to end: fake Sheet, fake Shovels, and stand-ins for the Gmail steps.
const test = require('node:test');
const {loadGas, assert} = require('./gas');
const {FakeSpreadsheetApp, FakeProperties, FakeShovels, contractor} = require('./fakes');

const TODAY = '2026-10-21';

function fresh({killSwitch = 'yes', usedBefore = 0} = {}) {
  const gas = loadGas();
  const ss = gas.setupSheets(new FakeSpreadsheetApp(), new FakeProperties()).spreadsheet;
  ss.getSheetByName('kill_switch').getRange(2, 1).setValues([[killSwitch]]);
  const api = new FakeShovels();
  api.usedBefore = usedBefore;
  const steps = [];
  const run = () => gas.runDaily_(ss, new gas.ShovelsClient('test-key', api.fetch), {
    today: TODAY,
    now: () => '2026-10-21 07:05',
    checkBounces: () => steps.push('bounces'),
    send: leads => { steps.push(`send ${leads.length}`); return leads.length; },
  });
  return {gas, ss, api, steps, run};
}

function readTab(ss, name) {
  const [header, ...rows] = ss.getSheetByName(name).rows();
  return rows.map(row => Object.fromEntries(header.map((h, i) => [h, row[i]])));
}

const paid = api => api.calls.filter(c => c.path === '/contractors/search').length;

test('kill switch off: no Shovels calls, no Gmail steps, but the run is logged', () => {
  const {api, steps, run, ss} = fresh({killSwitch: 'no'});
  run();
  assert.equal(api.calls.length, 0);
  assert.deepEqual(steps, []);
  assert.deepEqual(readTab(ss, 'run_log'), [{ran_at: '2026-10-21 07:05', ingested: 'no', credits_used: '0',
    credits_remaining: '', leads: '0', emails_sent: '0', note: 'kill switch is not "yes": nothing done'}]);
});

test('enough credits: bounces, then ingestion within the cap, then sending, all logged', () => {
  const {gas, api, steps, run, ss} = fresh({usedBefore: 465});  // 35 left, like the live account
  const log = run();

  assert.equal(api.calls[0].path, '/usage');  // the guard asks before anything is spent
  assert.ok(api.billed > 0 && api.billed <= gas.RUN_CREDIT_CAP, `billed ${api.billed}`);
  assert.equal(steps[0], 'bounces');
  assert.equal(steps[1], `send ${log.leads}`);
  assert.equal(gas.loadLeads(ss).length, log.leads);
  const [row] = readTab(ss, 'run_log');
  assert.equal(row.ingested, 'yes');
  assert.equal(row.credits_used, String(api.billed));
  assert.equal(row.emails_sent, String(log.leads));
});

test('a run spends at most RUN_CREDIT_CAP, however few leads it has found', () => {
  const {gas, api, run} = fresh();
  // 40 permit-service contractors: all billed, none a lead, so only the cap stops the run.
  const ids = Array.from({length: 40}, (_, k) => 40 + k);
  ids.forEach(i => { api.contractors[`C${i}`] = contractor(i, {primary_email: `x${i}@ipermitca.com`}); });
  api.addPermits('CA', '2026-10-11', ids);
  run();
  assert.equal(api.billed, gas.RUN_CREDIT_CAP);
});

test('below the floor: ingestion is skipped, pending leads are still sent', () => {
  const {gas, api, steps, run, ss} = fresh({usedBefore: 500 - 19});  // 19 left, one under MIN_CREDITS_TO_RUN
  run();
  assert.deepEqual(api.calls.map(c => c.path), ['/usage']);
  assert.deepEqual(steps, ['bounces', 'send 0']);
  const [row] = readTab(ss, 'run_log');
  assert.equal(row.ingested, 'no');
  assert.equal(row.credits_remaining, String(gas.MIN_CREDITS_TO_RUN - 1));
  assert.match(row.note, /under 20: ingestion skipped/);
});

test('the cap never exceeds the floor, so a run can\'t overdraw', () => {
  const {gas} = fresh();
  assert.ok(gas.RUN_CREDIT_CAP <= gas.MIN_CREDITS_TO_RUN);
});

test('an unreadable balance skips ingestion (fails closed)', () => {
  const {gas, api, ss} = fresh();
  const realFetch = api.fetch;
  api.fetch = (url, headers) => (url.includes('/usage') ? {status: 401, headers: {}, body: 'nope'} : realFetch(url, headers));
  gas.runDaily_(ss, new gas.ShovelsClient('k', api.fetch), {
    today: TODAY, now: () => 'now', checkBounces: () => {}, send: () => 0,
  });
  assert.equal(paid(api), 0);
  assert.match(readTab(ss, 'run_log')[0].note, /credit check failed, ingestion skipped: HTTP 401/);
});

test('a failure mid-run is logged with what was already paid for, then rethrown', () => {
  const {api, run, ss} = fresh();
  api.minPage = 2;
  api.failOnSearch = 2;  // the second paid search fails
  assert.throws(run, /HTTP 400/);
  const [row] = readTab(ss, 'run_log');
  assert.equal(row.ingested, 'yes');
  assert.equal(row.credits_used, String(api.billed));
  assert.ok(Number(row.leads) > 0, 'leads from the first page are kept and counted');
  assert.match(row.note, /error: HTTP 400/);
});

test('triggers: one per weekday at the run hour, and rerunning replaces them', () => {
  const {gas} = fresh();
  const triggers = [];
  const scriptApp = {
    WeekDay: {MONDAY: 'MON', TUESDAY: 'TUE', WEDNESDAY: 'WED', THURSDAY: 'THU', FRIDAY: 'FRI', SATURDAY: 'SAT', SUNDAY: 'SUN'},
    getProjectTriggers: () => [...triggers],
    deleteTrigger: t => triggers.splice(triggers.indexOf(t), 1),
    newTrigger: handler => {
      const t = {handler, getHandlerFunction: () => handler};
      const builder = {
        timeBased: () => builder,
        onWeekDay: day => { t.day = day; return builder; },
        atHour: hour => { t.hour = hour; return builder; },
        create: () => { triggers.push(t); return t; },
      };
      return builder;
    },
  };
  triggers.push({handler: 'somethingElse', getHandlerFunction: () => 'somethingElse'});

  assert.deepEqual(gas.installTriggers_(scriptApp), {removed: 0, created: 5});
  assert.deepEqual(gas.installTriggers_(scriptApp), {removed: 5, created: 5});
  const ours = triggers.filter(t => t.handler === 'dailyRun');
  assert.deepEqual(ours.map(t => [t.day, t.hour]), [['MON', 7], ['TUE', 7], ['WED', 7], ['THU', 7], ['FRI', 7]]);
  assert.equal(triggers.length, 6, 'other triggers are left alone');
  assert.equal(gas.removeTriggers_(scriptApp), 5);
  assert.equal(triggers.length, 1);
});

test('client usage(): balance from the free /usage endpoint', () => {
  const {gas} = fresh();
  const urls = [];
  const client = new gas.ShovelsClient('k', url => {
    urls.push(url);
    return {status: 200, headers: {}, body: JSON.stringify({credits_used: 465, credit_limit: 500, is_over_limit: false,
                                                            available_at: null, daily_usage: []})};
  });
  assert.deepEqual(client.usage(), {limit: 500, used: 465, remaining: 35, overLimit: false});
  assert.deepEqual(urls, ['https://api.shovels.ai/v2/usage']);
  assert.equal(client.creditsUsed, 0);
});
