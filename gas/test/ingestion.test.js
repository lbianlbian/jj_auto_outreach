// fetchLeads against a fake Shovels API (no network, no credits).
const test = require('node:test');
const {loadGas, plain, assert} = require('./gas');
const {FakeShovels, FakeSpreadsheetApp, FakeProperties} = require('./fakes');

const TODAY = '2026-10-21';

function setup() {
  const gas = loadGas();
  const api = new FakeShovels();
  const seed = gas.SCHEMA.blocklist.seed;
  const blocklist = new gas.Blocklist(seed.company, seed.email_domain);
  // Runs only the electrician search unless `searches` is passed.
  const fetch = (states, targetLeads, {knownLeads = [], searchLog = {}, ...rest} = {}) =>
    gas.fetchLeads(new gas.ShovelsClient('test-key', api.fetch), states,
                   {days: 30, targetLeads, searches: [electricians(gas)], blocklist, knownLeads, searchLog,
                    today: TODAY, ...rest});
  return {gas, api, blocklist, fetch};
}

const byName = (gas, name) => gas.LEAD_SEARCHES.find(search => search.name === name);
const electricians = gas => byName(gas, 'electrician');
const gcs = gas => byName(gas, 'gc');
const bySearch = (result, name) => result.leads.filter(l => l.search === name).map(l => l.name);

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
    state: 'CA', permit_date: '2026-10-11', project_type: 'new construction', search: 'electrician',
  });
});

test('newest day with data is skipped as partial', () => {
  const {api, fetch} = setup();
  fetch(['CA'], 3);
  assert.deepEqual(api.searched()[0], ['CA', '2026-10-11']);
  assert.ok(!api.searched().some(([, day]) => day === '2026-10-12'));
});

test('both searches send their filters exactly', () => {
  // The real API silently ignores misspelled params and values, so pin the exact names and
  // encoding. These match `shovels.exe contractors search --dry-run` (checked 2026-11-17).
  const {gas, api, fetch} = setup();
  api.addPermits('CA', '2026-10-11', [40]);
  fetch(['CA'], 20, {searches: [electricians(gas), gcs(gas)]});
  const excludedClasses = ['-general_engineering_contractor', '-roofing', '-concrete_and_paving',
                           '-landscaping_and_outdoor_work'];
  const excludedTags = ['-solar', '-battery', '-ev_charger', '-generator', '-fire_sprinkler', '-telecom'];
  const expected = {
    electrician: {classes: ['electrical', ...excludedClasses], tags: ['electrical', ...excludedTags]},
    gc: {classes: ['general_building_contractor', '-electrical', ...excludedClasses], tags: excludedTags},
  };
  const searches = api.calls.filter(c => c.path === '/contractors/search');
  assert.deepEqual([...new Set(api.searchKinds())], ['electrician', 'gc']);
  searches.forEach(({params, headers}, i) => {
    const want = expected[api.searchKinds()[i]];
    assert.deepEqual(params.contractor_classification_derived, want.classes);
    assert.deepEqual(params.permit_tags, want.tags);
    assert.deepEqual(params.property_type, ['residential']);
    assert.equal(headers['X-API-Key'], 'test-key');
  });
  assert.ok(!api.returned.includes('C90'));  // the HVAC shop on 10-11 is filtered by the server
});

test('the URL repeats list params with "-" excludes intact', () => {
  const {gas} = setup();
  let url;
  const client = new gas.ShovelsClient('k', u => { url = u; return {status: 200, headers: {}, body: '{"items":[]}'}; });
  client.searchContractorsPage('CA', '2026-10-11', '2026-10-11', 5, null, gas.searchFilters(gcs(gas)));
  assert.match(url, /contractor_classification_derived=general_building_contractor&contractor_classification_derived=-electrical&/);
  assert.match(url, /permit_tags=-solar&permit_tags=-battery&/);
  assert.match(url, /property_type=residential/);
});

test('one shared target: the first search takes what it finds, the second gets the rest', () => {
  const {gas, api, fetch} = setup();
  // C41 is a GC and an electrician, C42 a GC and a roofer, C44 a commercial builder by industry code.
  api.addPermits('CA', '2026-10-11', [40, 41, 42, 43, 44, 45]);
  const result = fetch(['CA'], 8, {searches: [electricians(gas), gcs(gas)]});

  // 6 electricians on 10-11 (C41 counts as one), then the GC search asks for the last 2.
  assert.deepEqual(bySearch(result, 'electrician'), ['Shop 1', 'Shop 7', 'Shop 8', 'Shop 27', 'Shop 28', 'Builds And Wires']);
  assert.deepEqual(bySearch(result, 'gc'), ['Home Remodel Co', 'Custom Homes']);
  assert.ok(!api.returned.includes('C42'));  // the roofer is excluded by Shovels
  assert.deepEqual(plain(api.searchKinds()), ['electrician', 'electrician', 'gc']);
  const gcPage = api.calls.filter(c => c.path === '/contractors/search')[2];
  assert.equal(gcPage.params.size, '2');  // pages shrink to what the run still needs
  assert.deepEqual([...new Set(api.searched().map(([, day]) => day))], ['2026-10-11']);  // one day was enough
});

test('both searches run on each day until the run has enough', () => {
  const {gas, api, fetch} = setup();
  api.addPermits('CA', '2026-10-10', [43]);
  const result = fetch(['CA'], 8, {searches: [gcs(gas), electricians(gas)]});
  // 10-11: no GCs (free), 5 electricians. 10-10: the GC search goes first again, then electricians.
  assert.deepEqual(result.leads.map(l => l.name),
                   ['Shop 1', 'Shop 7', 'Shop 8', 'Shop 27', 'Shop 28', 'Custom Homes', 'Shop 9', 'Shop 10']);
  const order = api.calls.filter(c => c.path === '/contractors/search')
    .map((c, i) => `${c.params.permit_from} ${api.searchKinds()[i]}`);
  assert.deepEqual([...new Set(order)], ['2026-10-11 gc', '2026-10-11 electrician', '2026-10-10 gc',
                                         '2026-10-10 electrician']);
});

test('GCs go first on even days, electricians on odd days', () => {
  const {gas, api, fetch} = setup();
  const order = day => gas.searchesForDay(day).map(search => search.name);
  assert.deepEqual(plain(order('2026-10-22')), ['gc', 'electrician']);
  assert.deepEqual(plain(order('2026-10-21')), ['electrician', 'gc']);
  assert.deepEqual(plain(order('2026-11-01')), ['electrician', 'gc']);
  assert.deepEqual(plain(order('2026-10-30')), ['gc', 'electrician']);
  // fetchLeads uses that order when no searches are passed.
  fetch(['CA'], 3, {searches: undefined, today: '2026-10-22'});
  assert.equal(api.searchKinds()[0], 'gc');
});

test('excluded industry codes are skipped after Shovels returns them', () => {
  const {gas, api, fetch} = setup();
  api.addPermits('CA', '2026-10-11', [44, 45]);  // C44 is a commercial builder (NAICS 236220)
  const result = fetch(['CA'], 1, {searches: [gcs(gas)]});
  assert.equal(result.outcomes.C44, 'excluded industry');
  assert.deepEqual(result.leads.map(l => l.name), ['Cozy ADUs']);
});

test('maxContractors caps spend across both searches', () => {
  const {gas, api, fetch} = setup();
  api.addPermits('CA', '2026-10-11', [40, 43, 45]);
  const result = fetch(['CA'], 10, {searches: [electricians(gas), gcs(gas)], maxContractors: 13});
  // 11 electricians billed for 5 leads (C01..C08, C27, C28, C31), leaving 2 for the GC search.
  assert.equal(api.billed, 13);
  assert.deepEqual(result.leads.map(l => l.name),
                   ['Shop 1', 'Shop 7', 'Shop 8', 'Shop 27', 'Shop 28', 'Home Remodel Co', 'Custom Homes']);
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

for (const [fields, reason] of [
  [{permit_count: 499}, null],
  [{permit_count: 500}, 'too large'],  // 500 or more is too large
  [{naics: '339950'}, 'excluded industry'],  // signs (Signcraft)
  [{sic: '3993'}, 'excluded industry'],
  [{naics: '561621'}, 'excluded industry'],  // security and alarms
  [{sic: '7382'}, 'excluded industry'],
  [{naics: '236220'}, 'excluded industry'],  // commercial building
  [{naics: '236210'}, 'excluded industry'],  // industrial building
  [{naics: '237130'}, 'excluded industry'],  // power and communication lines
  [{naics: '423610', sic: null}, 'excluded industry'],  // electrical wholesalers
  [{naics: 339950}, 'excluded industry'],  // a number, not a string
  [{naics: '238210, 339950'}, 'excluded industry'],  // a list, just in case
  [{naics: '238210', sic: '1731'}, null],  // electrical contractors
  [{naics: '236118'}, null],  // residential remodelers
  [{naics: null, sic: null}, null],  // usually null: passes
  [{naics: '3399500'}, null],  // whole codes only
]) {
  test(`size and industry: ${JSON.stringify(fields)}`, () => {
    const {gas} = setup();
    const contractor = {primary_email: 'bob@shop.com', permit_count: 5, ...fields};
    assert.equal(gas.skipReason(contractor, gas.MAX_CONTRACTOR_PERMITS, new gas.Blocklist()), reason);
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

test('kill switch: ingestion makes no Shovels calls unless it says "yes"', () => {
  const {gas, api} = setup();
  const ss = gas.setupSheets(new FakeSpreadsheetApp(), new FakeProperties()).spreadsheet;
  const ingest = () => gas.ingest_(ss, new gas.ShovelsClient('test-key', api.fetch), TODAY, ['CA']);
  const killSwitch = ss.getSheetByName('kill_switch').getRange(2, 1);

  for (const value of ['no', '', 'stop']) {  // "no" is the seeded value
    killSwitch.setValues([[value]]);
    assert.equal(ingest(), null, `"${value}"`);
  }
  assert.equal(api.calls.length, 0);  // not even the free coverage calls
  assert.deepEqual(gas.loadLeads(ss), []);
  assert.deepEqual(gas.loadSearchLog(ss), {});

  killSwitch.setValues([['yes']]);
  const leads = ingest();
  assert.ok(api.billed > 0 && leads.length > 0);
  assert.deepEqual(gas.loadLeads(ss).map(r => r.contractor_id), leads.map(l => l.contractor_id));
});
