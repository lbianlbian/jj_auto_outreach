// The dashboard's numbers and page, from a fake Sheet. No Google, Shovels or Gmail calls.
const test = require('node:test');
const {loadGas, assert} = require('./gas');
const {FakeSpreadsheetApp, FakeProperties} = require('./fakes');

const TODAY = '2026-10-30';

function fresh({killSwitch = 'no'} = {}) {
  const gas = loadGas();
  const ss = gas.setupSheets(new FakeSpreadsheetApp(), new FakeProperties()).spreadsheet;
  ss.getSheetByName('kill_switch').getRange(2, 1).setValues([[killSwitch]]);
  return {gas, ss};
}

const lead = (id, fields = {}) => ({contractor_id: id, name: `Shop ${id}`, email: `${id}@shop.com`, ...fields});

function seed(gas, ss) {
  gas.appendLeads(ss, [
    lead('C1', {emailed_at: '2026-10-28 07:10'}),
    lead('C2', {emailed_at: '2026-10-28 07:11'}),
    lead('C3', {emailed_at: '2026-10-29 07:05'}),
    lead('C4', {emailed_at: '2026-10-01 07:05'}),  // outside the 14-day chart
    lead('C5'),                                    // waiting to send
    lead('C6'),                                    // dead domain, never sent
    lead('C7', {email: ''}),                       // no email: not pending
  ]);
  gas.updateLead(ss, 'C1', {email_success: 'yes'});
  gas.updateLead(ss, 'C2', {email_success: 'no'});
  gas.updateLead(ss, 'C6', {email_success: 'no'});
  [
    {ran_at: '2026-09-20 07:00', ingested: 'yes', credits_used: 20, credits_remaining: 300, leads: 9, emails_sent: 9},
    {ran_at: '2026-10-28 07:00', ingested: 'yes', credits_used: 18, credits_remaining: 40, leads: 2, emails_sent: 2},
    {ran_at: '2026-10-29 07:00', ingested: 'yes', credits_used: 15, credits_remaining: 25, leads: 1, emails_sent: 1},
    {ran_at: '2026-10-30 07:00', ingested: 'no', credits_used: 0, credits_remaining: '', leads: 0, emails_sent: 0,
     note: 'kill switch is not "yes": nothing done'},
  ].forEach(row => gas.appendRunLog(ss, row));
}

test('counts leads, sends, bounces and pending the way sending does', () => {
  const {gas, ss} = fresh();
  seed(gas, ss);
  const data = gas.dashboardData(ss, TODAY);
  assert.deepEqual(data.leads, {total: 7, emailed: 4, pending: 1, undeliverable: 1, bounced: 1, delivered: 1,
                                bounceRate: 0.25});
  assert.equal(data.leads.pending, gas.pendingLeads(gas.loadLeads(ss), []).length);
  assert.equal(data.outreachOn, false);
});

test('sends per day cover the last 14 days, zeros included, oldest first', () => {
  const {gas, ss} = fresh();
  seed(gas, ss);
  const {sentByDay, sentInWindow} = gas.dashboardData(ss, TODAY);
  assert.equal(sentByDay.length, gas.DASHBOARD_DAYS);
  assert.equal(sentByDay[0].day, '2026-10-17');
  assert.equal(sentByDay[sentByDay.length - 1].day, TODAY);
  assert.deepEqual(sentByDay.filter(d => d.count), [{day: '2026-10-28', count: 2}, {day: '2026-10-29', count: 1}]);
  assert.equal(sentInWindow, 3);
});

test('credits: latest known balance, and spend over the rolling 30 days', () => {
  const {gas, ss} = fresh();
  seed(gas, ss);
  const {credits, lastRun, recentRuns, recentLeads} = gas.dashboardData(ss, TODAY);
  // The skipped run has no balance, so the one before it is the latest known.
  assert.deepEqual(credits, {remaining: '25', asOf: '2026-10-29 07:00', usedLast30: 33});
  assert.equal(lastRun.ran_at, '2026-10-30 07:00');
  assert.equal(recentRuns[0].ran_at, '2026-10-30 07:00');
  assert.deepEqual(recentLeads.map(l => l.name), ['Shop C3', 'Shop C2', 'Shop C1', 'Shop C4']);
});

test('an empty Sheet renders without errors', () => {
  const {gas, ss} = fresh({killSwitch: 'yes'});
  const data = gas.dashboardData(ss, TODAY);
  assert.equal(data.leads.bounceRate, null);
  assert.equal(data.credits.remaining, null);
  const html = gas.renderDashboard(data);
  assert.match(html, /Automatic outreach is ON/);
  assert.match(html, /No emails sent yet/);
  assert.match(html, /No runs logged yet/);
});

test('the page shows the kill switch and escapes Sheet text', () => {
  const {gas, ss} = fresh();
  seed(gas, ss);
  gas.appendLeads(ss, [lead('C8', {name: 'A&B <script>alert(1)</script>', emailed_at: '2026-10-30 07:01'})]);
  const html = gas.renderDashboard(gas.dashboardData(ss, TODAY));
  assert.match(html, /Automatic outreach is OFF/);
  assert.match(html, /A&amp;B &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /kill switch is not &quot;yes&quot;/);
});

test('the public page needs the exact key, and no key set means no one gets in', () => {
  const {gas} = fresh();
  const props = new FakeProperties();
  assert.equal(gas.dashboardKeyMatches({}, props), false);
  assert.equal(gas.dashboardKeyMatches({key: ''}, props), false);  // unset key must not match a blank one
  assert.equal(gas.dashboardKeyMatches(undefined, props), false);
  props.setProperty('DASHBOARD_KEY', 'k-123');
  assert.equal(gas.dashboardKeyMatches({key: 'k-123'}, props), true);
  assert.equal(gas.dashboardKeyMatches({key: 'k-12'}, props), false);
  assert.equal(gas.dashboardKeyMatches({}, props), false);
});

test('setup\'s key is made once, so rerunning setup() never breaks shared links', () => {
  const {gas} = fresh();
  const props = new FakeProperties();
  let made = 0;
  const makeKey = () => `key-${++made}`;
  assert.equal(gas.ensureDashboardKey(props, makeKey), 'key-1');
  assert.equal(gas.ensureDashboardKey(props, makeKey), 'key-1');
  assert.equal(made, 1);
  assert.equal(gas.dashboardKeyMatches({key: 'key-1'}, props), true);
});

test('the dashboard never calls Shovels or Gmail', () => {
  const {gas} = fresh();
  const source = gas.dashboardData.toString() + gas.renderDashboard.toString();
  assert.doesNotMatch(source, /UrlFetchApp|GmailApp|ShovelsClient|fetch\(/);
});
