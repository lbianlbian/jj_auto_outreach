// fetchLeads against a fake Shovels API (no network, no credits).
const test = require('node:test');
const {loadGas, plain, assert} = require('./gas');
const {FakeShovels} = require('./fakes');

const TODAY = '2026-10-21';

function setup() {
  const gas = loadGas();
  const api = new FakeShovels();
  const seed = gas.SCHEMA.blocklist.seed;
  const blocklist = new gas.Blocklist(seed.company, seed.email_domain);
  const fetch = (states, targetLeads, {knownLeads = [], searchLog = {}, ...rest} = {}) =>
    gas.fetchLeads(new gas.ShovelsClient('test-key', api.fetch), states,
                   {days: 30, targetLeads, blocklist, knownLeads, searchLog, today: TODAY, ...rest});
  return {gas, api, blocklist, fetch};
}

const names = result => result.leads.map(lead => lead.name);
const nonLeads = outcomes => Object.fromEntries(Object.entries(outcomes).filter(([, s]) => s !== 'lead'));
// What the leads tab holds after a run: the rows a later run reads back as knownLeads.
const asRows = result => result.leads.map(({contractor_id, email}) => ({contractor_id, email}));

test('first run filters and records outcomes', () => {
  const {fetch} = setup();
  const searchLog = {};
  const result = fetch(['CA'], 3, {searchLog});

  assert.deepEqual(names(result), ['Shop 1', 'Shop 7', 'Shop 8']);
  assert.equal(result.leads[0].email, 'x1@shop1.com');
  assert.equal(result.leads[0].permit_date, '2026-10-11');
  assert.deepEqual(plain(nonLeads(result.outcomes)), {
    C02: 'too large',
    C03: 'blocked email',
    C04: 'blocked email',
    C05: 'duplicate email',
    C06: 'blocklisted company',
  });
  assert.ok(!('C31' in result.outcomes));  // sorts after the 3rd lead, so never fetched
  assert.deepEqual(plain(searchLog), {CA: {last_searched: '2026-10-21', days: ['2026-10-11']}});
});

test('lead rows carry the template slots', () => {
  const {api, fetch} = setup();
  Object.assign(api.contractors.C01, {primary_phone: '(205) 585-8598', address: {city: 'BESSEMER', state: 'CA', zip_code: '35020'},
                                      tag_tally: {electrical: 3, new_construction: 2, remodel: 1}});
  const lead = fetch(['CA'], 1).leads[0];
  assert.deepEqual(plain({...lead, contractor: undefined}), {
    contractor_id: 'C01', name: 'Shop 1', email: 'x1@shop1.com', phone: '(205) 585-8598', city: 'BESSEMER', zip_code: '35020',
    state: 'CA', permit_date: '2026-10-11', project_type: 'new construction',
  });
});

test('newest day with data is skipped as partial', () => {
  const {api, fetch} = setup();
  fetch(['CA'], 3);
  assert.deepEqual(api.searched()[0], ['CA', '2026-10-11']);
  assert.ok(!api.searched().some(([, day]) => day === '2026-10-12'));
});

test('classification filter and list params are sent exactly', () => {
  // The real API silently ignores misspelled params, so pin the exact names and encoding.
  const {api, fetch} = setup();
  fetch(['CA'], 10);
  const searches = api.calls.filter(c => c.path === '/contractors/search');
  assert.ok(searches.length);
  for (const {params, headers} of searches) {
    assert.deepEqual(params.contractor_classification_derived, ['electrical']);
    assert.deepEqual(params.permit_tags, ['electrical']);
    assert.equal(headers['X-API-Key'], 'test-key');
  }
  assert.ok(!api.returned.includes('C90'));  // the HVAC shop on 10-11 is filtered by the server
});

test('no paid contractor goes unused', () => {
  const {api, fetch} = setup();
  fetch(['CA'], 3);
  // C01-C08 are needed to find 3 leads; pages shrink to what's still needed, so no 9th.
  assert.deepEqual(api.returned, ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08']);
  assert.ok(api.calls.every(c => c.path !== '/contractors/search' || Number(c.params.size) >= 1));
});

test('every lead on a paid page is kept, even past the target', () => {
  const {api, fetch} = setup();
  api.minPage = 20;  // the API hands back more than the 3 asked for
  const result = fetch(['CA'], 3);
  // All 11 contractors on 10-11 came back on one billed page, so all 5 leads on it are kept.
  assert.equal(api.searched().length, 1);
  assert.equal(api.billed, 11);
  assert.deepEqual(names(result), ['Shop 1', 'Shop 7', 'Shop 8', 'Shop 27', 'Shop 28']);
});

test('each day is searched only once', () => {
  const {api, fetch} = setup();
  const searchLog = {};
  const first = fetch(['CA'], 3, {searchLog});
  api.reset();

  const result = fetch(['CA'], 3, {searchLog, knownLeads: asRows(first)});

  assert.deepEqual(names(result), ['Shop 9', 'Shop 10', 'Shop 11']);
  assert.deepEqual([...new Set(api.searched().map(String))], ['CA,2026-10-10']);  // 10-11 isn't searched again
  assert.deepEqual(api.returned, ['C01', 'C09', 'C10', 'C11']);  // C01 is paid for again, then skipped
  assert.equal(result.outcomes.C01, 'already a lead');
  assert.deepEqual(plain(searchLog.CA.days), ['2026-10-10', '2026-10-11']);
});

test('an email already in the leads tab is a duplicate, whatever the contractor id', () => {
  const {fetch} = setup();
  const result = fetch(['CA'], 1, {knownLeads: [{contractor_id: 'OLD', email: 'X1@shop1.com'}]});
  assert.equal(result.outcomes.C01, 'duplicate email');
  assert.deepEqual(names(result), ['Shop 7']);
});

test('rejected contractors are not remembered, so a blocklist edit takes effect', () => {
  const {gas, fetch} = setup();
  // With no seen list, a rejected contractor is just filtered again when it turns up.
  const result = fetch(['CA'], 10, {blocklist: new gas.Blocklist([], [])});
  assert.equal(result.outcomes.C06, 'lead');  // Sunrun, once it's off the blocklist
});

test('a new batch moves the starting day', () => {
  const {api, fetch} = setup();
  const searchLog = {};
  const first = fetch(['CA'], 3, {searchLog});
  api.addPermits('CA', '2026-10-13', [22, 23]);
  api.addPermits('CA', '2026-10-14', [24]);  // new newest day, partial
  api.reset();

  const result = fetch(['CA'], 1, {searchLog, knownLeads: asRows(first)});

  assert.deepEqual(names(result), ['Shop 22']);
  assert.deepEqual(plain(api.searched()), [['CA', '2026-10-13']]);
});

test('walks back across days until full', () => {
  const {api, fetch} = setup();
  const result = fetch(['CA'], 12);  // 5 leads on 10-11, 5 on 10-10, 2 more needed
  assert.deepEqual([...new Set(api.searched().map(([, day]) => day))], ['2026-10-11', '2026-10-10', '2026-10-09']);
  assert.equal(result.leads.length, 12);
});

test('stops before the next state once full', () => {
  const {api, fetch} = setup();
  api.addPermits('TX', '2026-10-11', [25, 26]);
  fetch(['CA', 'TX'], 3);
  assert.ok(api.calls.every(c => c.params.geo_id === 'CA'));
});

test('rotation visits least recently searched first', () => {
  const {api, fetch} = setup();
  api.addPermits('TX', '2026-10-11', [25]);
  api.addPermits('TX', '2026-10-12', [26]);
  const result = fetch(['CA', 'TX'], 1, {searchLog: {CA: {last_searched: '2026-10-20', days: []}}});
  assert.deepEqual(names(result), ['Shop 25']);  // never-searched TX beats CA searched yesterday
});

test('a state with no data still rotates back', () => {
  const {api, fetch} = setup();
  const searchLog = {};
  fetch(['WY', 'CA'], 1, {searchLog});
  assert.deepEqual(plain(searchLog.WY), {last_searched: '2026-10-21', days: []});
  assert.ok(!api.searched().some(([geo]) => geo === 'WY'));  // no paid calls for WY
});

test('a contractor based in an unshippable state is skipped', () => {
  const {fetch} = setup();
  assert.equal(fetch(['CA'], 10).outcomes.C31, 'unshippable state');
});

test('unshippable states are never searched', () => {
  const {api, fetch} = setup();
  api.addPermits('AK', '2026-10-11', [25]);
  api.addPermits('HI', '2026-10-11', [26]);
  const searchLog = {};
  const result = fetch(['AK', 'hi', 'CA'], 1, {searchLog});
  assert.deepEqual(names(result), ['Shop 1']);
  assert.deepEqual([...new Set(api.calls.map(c => c.params.geo_id))], ['CA']);  // not even a free coverage call
  assert.deepEqual(Object.keys(searchLog), ['CA']);
});

test('the default state list leaves out Alaska and Hawaii', () => {
  const {gas} = setup();
  assert.ok(!gas.US_STATES.includes('AK') && !gas.US_STATES.includes('HI'));
  assert.equal(gas.US_STATES.length, 49);  // 48 states + DC
});

test('maxContractors caps spend', () => {
  const {api, fetch} = setup();
  const result = fetch(['CA'], 10, {maxContractors: 4});
  assert.equal(api.billed, 4);
  assert.deepEqual(names(result), ['Shop 1']);
});

test('days before the lookback are forgotten', () => {
  const {fetch} = setup();
  const searchLog = {CA: {last_searched: '2026-08-01', days: ['2026-08-01', '2026-10-11']}};
  fetch(['CA'], 1, {searchLog});
  assert.deepEqual(plain(searchLog.CA.days), ['2026-10-10', '2026-10-11']);
});

test('a failure hands back the leads already paid for, and the day counts as searched', () => {
  const {api, fetch} = setup();
  api.failOnSearch = 3;  // 10-11 takes 2 pages and gives 5 of the 8 leads; the 10-10 page fails
  const searchLog = {};
  let error;
  try {
    fetch(['CA'], 8, {searchLog});
  } catch (e) {
    error = e;
  }
  assert.match(error.message, /HTTP 400/);
  assert.deepEqual(error.partial.leads.map(l => l.name), ['Shop 1', 'Shop 7', 'Shop 8', 'Shop 27', 'Shop 28']);
  assert.deepEqual(plain(searchLog.CA.days), ['2026-10-10', '2026-10-11']);
});

test('coverage without items counts as data', () => {
  const {gas} = setup();
  const client = {permitsTotal: () => null};  // every field reliable: no items, so no count
  assert.equal(gas.newestDayWithData(client, 'CA', TODAY, '2026-09-21'), TODAY);
});

for (const [email, reason] of [
  ['permits@cityofmesa.gov', 'blocked email'],
  ['intake@dot.ca.gov', 'blocked email'],
  ['bob@govelectric.com', null],  // "gov" inside a business domain is fine
  ['bob@shop.gov.example.com', null],
  ['', 'no primary email'],
  ['bob@localhost', 'no primary email'],
]) {
  test(`gov and missing emails: ${email || '(blank)'}`, () => {
    const {gas} = setup();
    assert.equal(gas.skipReason({primary_email: email, permit_count: 5}, gas.MAX_CONTRACTOR_PERMITS,
                                new gas.Blocklist()), reason);
  });
}

for (const [contractor, blocked] of [
  [{business_name: 'SUNRUN INSTALLATION SERVICES INC.'}, true],
  [{business_name: 'AT&T SERVICES'}, true],
  [{dba: 'A.T. & T'}, true],
  [{business_name: 'LOWES HOME CENTERS'}, true],
  [{name: 'x', dba: 'Tesla Energy'}, true],
  [{business_name: 'BRADT SOLAR'}, false],  // "ADT Solar" must match whole words only
  [{business_name: 'SUNRUNNER ELECTRIC'}, false],  // "Sunrun" must not match inside a word
  [{business_name: 'BETTER ELECTRIC'}, false],
]) {
  test(`blocklist company matching: ${JSON.stringify(contractor)}`, () => {
    const {blocklist} = setup();
    assert.equal(blocklist.blocksCompany(contractor), blocked);
  });
}

test('blocklist email domains', () => {
  const {blocklist} = setup();
  for (const domain of ['ipermitca.com', 'sunrun.com', 'tesla.com']) assert.ok(blocklist.emailDomains.has(domain));
});

test('client retries 429s and 5xx, then tracks credits', () => {
  const {gas} = setup();
  const responses = [
    {status: 429, headers: {'retry-after': '3'}, body: ''},
    {status: 503, headers: {}, body: ''},
    {status: 200, headers: {'x-credits-request': '2', 'x-credits-remaining': '68'}, body: '{"items":[{},{}]}'},
  ];
  const sleeps = [];
  const client = new gas.ShovelsClient('k', () => responses.shift(), ms => sleeps.push(ms));
  const page = client.searchContractorsPage('CA', '2026-10-11', '2026-10-11', 2, null);
  assert.equal(page.items.length, 2);
  assert.deepEqual(sleeps, [3000, 2000]);
  assert.equal(client.creditsUsed, 2);
  assert.equal(client.creditsRemaining, 68);
});

test('client refuses a page size below 1 instead of sending it', () => {
  const {gas} = setup();
  const client = new gas.ShovelsClient('k', () => assert.fail('should not fetch'));
  assert.throws(() => client.searchContractorsPage('CA', '2026-10-11', '2026-10-11', 0, null), /at least 1/);
});
