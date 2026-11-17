/**
 * The fake outside world a dry run talks to: Shovels, DNS and a Gmail mailbox, plus a fake
 * Sheet for running the dry run offline (npm run dry-run). Nothing here is real, and every
 * fake name and address says "fake" so a stray one is easy to spot.
 *
 * request(url) answers HTTP and throws for any host it doesn't fake, so a dry run can never
 * reach a real service. A new outside call (a new API, a new Shovels endpoint) needs a
 * fake route here; until it has one the dry run reports it as an unfaked call.
 */

// Kinds of contractor the fake Shovels returns, in rotation, so a run sees each filter at work.
// The Sheet's blocklist and filters.js decide what happens to each; nothing here is hard-wired.
const FAKE_CONTRACTOR_KINDS = [
  {label: 'small shop doing remodels', make: n => ({
    business_name: `FAKE BRIGHT SPARK ELECTRIC ${n}`, primary_email: `office@fake-brightspark-${n}.example`,
    permit_count: 40, tag_tally: {electrical: 12, remodel: 6, lighting: 2}})},
  {label: 'new-construction electrician', make: n => ({
    business_name: `FAKE NEWBUILD WIRING ${n} LLC`, primary_email: `jobs@fake-newbuild-${n}.example`,
    permit_count: 120, tag_tally: {electrical: 30, new_construction: 14}})},
  {label: 'fire sprinkler company (passes the filters today)', make: n => ({
    business_name: `FAKE FIRE SPRINKLER CO ${n}`, primary_email: `service@fake-sprinkler-${n}.example`,
    permit_count: 60, tag_tally: {electrical: 5, fire_sprinkler: 20}})},
  {label: 'permit-service email (blocklisted domain)', make: n => ({
    business_name: `FAKE PERMIT RUNNER ${n}`, primary_email: `fake${n}@ipermitca.com`,
    permit_count: 80, tag_tally: {electrical: 9}})},
  {label: 'based in Hawaii (unshippable)', make: n => ({
    business_name: `FAKE ALOHA ELECTRIC ${n}`, primary_email: `info@fake-aloha-${n}.example`,
    permit_count: 25, tag_tally: {electrical: 7}, address: {city: 'FAKE HONOLULU', state: 'HI', zip_code: '96800'}})},
  {label: 'domain with no mail server', make: n => ({
    business_name: `FAKE DEAD DOMAIN ELECTRIC ${n}`, primary_email: `owner@fake-nomx-${n}.example`,
    permit_count: 15, tag_tally: {electrical: 4, remodel: 1}})},
  {label: 'national firm (too large)', make: n => ({
    business_name: `FAKE MEGACORP ELECTRICAL ${n}`, primary_email: `bids@fake-megacorp-${n}.example`,
    permit_count: 9000, tag_tally: {electrical: 900}})},
  {label: 'no email on file', make: n => ({
    business_name: `FAKE NO EMAIL ELECTRIC ${n}`, primary_email: '',
    permit_count: 10, tag_tally: {electrical: 3}})},
];

// Fake contractors per state per day, and how many days behind "today" the newest fake permits are
// (real Shovels data runs ~9 days late; see docs/ingestion.md).
const FAKE_CONTRACTORS_PER_DAY = 3;
const FAKE_DATA_LAG_DAYS = 9;

/**
 * options: {creditLimit, creditsUsed, mailbox: [messages searchMail can find]}.
 * Returns {request(url, headers) -> {response, description, group}, searchMail(query, max), billed}.
 */
function fakeWorld_(today, options) {
  options = options || {};
  const world = {
    creditLimit: options.creditLimit || 500,
    creditsUsed: options.creditsUsed === undefined ? 400 : options.creditsUsed,
    newestDay: addDays(today, -FAKE_DATA_LAG_DAYS),
    oldestDay: addDays(today, -60),
    mailbox: options.mailbox || [],
    billed: 0,
  };

  /** The fake contractors with a permit in `state` on `day`, sorted by id like the real API. */
  world.contractorsOn = (state, day) => {
    if (day > world.newestDay || day < world.oldestDay) return [];
    const age = Math.round((Date.parse(world.newestDay) - Date.parse(day)) / 86400000);
    const stateIndex = Math.max(0, US_STATES.indexOf(state));
    const list = [];
    for (let k = 0; k < FAKE_CONTRACTORS_PER_DAY; k++) {
      const n = age * FAKE_CONTRACTORS_PER_DAY + k + 1;
      const kind = FAKE_CONTRACTOR_KINDS[(n - 1 + stateIndex) % FAKE_CONTRACTOR_KINDS.length];
      const made = kind.make(n);
      list.push(Object.assign({
        id: `FAKE-${state}-${day.replace(/-/g, '')}-${k + 1}`,
        name: made.business_name,
        primary_phone: '+15550100000',
        classification_derived: ['electrical'],
        address: {city: 'FAKE CITY', state: state, zip_code: '00000'},
        fake_kind: kind.label,
      }, made));
    }
    return list;
  };

  world.request = (url, headers) => {
    const parsed = parseUrl_(url);
    if (parsed.host === 'api.shovels.ai') return fakeShovels_(world, parsed.path.replace(/^\/v2/, ''), parsed.params);
    if (parsed.host === 'dns.google') return fakeDns_(parsed.params.name);
    throw new Error(`dry run: no fake for ${parsed.host}${parsed.path}. Add one to src/dryrun/fake_world.js ` +
                    'so dry runs never reach a real service.');
  };

  world.searchMail = (query, max) => world.mailbox.slice(0, max);
  return world;
}

function fakeShovels_(world, path, params) {
  const json = (body, headers) => ({status: 200, headers: headers || {}, body: JSON.stringify(body)});
  if (path === '/usage') {
    const used = world.creditsUsed + world.billed;
    return {response: json({credits_used: used, credit_limit: world.creditLimit, is_over_limit: used >= world.creditLimit}),
            description: `Shovels /usage: ${world.creditLimit - used} credits left (free)`};
  }
  if (path === '/meta/coverage') {
    let total = 0;
    for (let day = params.date_from; day <= params.date_to; day = addDays(day, 1)) {
      total += world.contractorsOn(params.geo_id, day).length;
    }
    return {response: json({items: [{field: 'fees', tier: 'missing', permits_total: total}]}),
            description: `Shovels /meta/coverage ${params.geo_id}: checking which days have permits (free)`,
            group: `coverage ${params.geo_id}`};
  }
  if (path === '/contractors/search') {
    const size = Number(params.size);
    const all = [];
    for (let day = params.permit_from; day <= params.permit_to; day = addDays(day, 1)) {
      all.push(...world.contractorsOn(params.geo_id, day));
    }
    const rest = all.sort((a, b) => (a.id < b.id ? -1 : 1)).filter(c => c.id > (params.cursor || ''));
    const page = rest.slice(0, size);
    world.billed += page.length;
    const remaining = world.creditLimit - world.creditsUsed - world.billed;
    const headers = page.length ? {'x-credits-request': String(page.length), 'x-credits-remaining': String(remaining)} : {};
    const day = params.permit_from === params.permit_to ? params.permit_from : `${params.permit_from}..${params.permit_to}`;
    return {
      response: json({items: page, next_cursor: rest.length > page.length ? page[page.length - 1].id : null}, headers),
      description: `Shovels /contractors/search ${params.geo_id} ${day} size=${size}: ${page.length} contractors, ` +
        `would cost ${page.length} credits` + page.map(c => `\n      ${c.id} ${c.name} <${c.primary_email}>: ${c.fake_kind}`).join(''),
    };
  }
  return {response: {status: 404, headers: {}, body: '{"detail":"Not Found"}'},
          description: `Shovels ${path}: not faked, answered 404. Add a fake to src/dryrun/fake_world.js`};
}

/** Every fake domain has a mail server except fake-nomx-* ones. Real domains (from a copied Sheet) do too. */
function fakeDns_(domain) {
  const dead = /^fake-nomx-/.test(String(domain));
  const body = dead ? {Status: 3} : {Status: 0, Answer: [{type: 15, data: '10 mx.fake.example.'}]};
  return {response: {status: 200, headers: {}, body: JSON.stringify(body)},
          description: `DNS MX lookup ${domain}: ${dead ? 'no mail server' : 'has a mail server'}`};
}

/** 'https://host/path?a=1&a=2&b=x' -> {host, path, params: {a: ['1', '2'], b: 'x'}}. Apps Script has no URL class. */
function parseUrl_(url) {
  const match = String(url).match(/^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/);
  if (!match) throw new Error(`dry run: can't parse URL ${url}`);
  const params = {};
  (match[3] || '').split('&').filter(Boolean).forEach(part => {
    const [key, value] = part.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' ')));
    if (key in params) params[key] = [].concat(params[key], value || '');
    else params[key] = value || '';
  });
  return {host: match[1].toLowerCase(), path: match[2] || '/', params};
}

/**
 * A fake Sheet built by setupSheets() from SCHEMA, so it has every tab and column the code
 * expects, filled with: the seed template with each [placeholder] filled with fake text,
 * the kill switch at "yes", and three leads from "earlier runs" (one delivered, one whose
 * email bounced, one never emailed). Returns {spreadsheet, mailbox} where mailbox holds
 * the bounce notice for the bounced lead.
 */
function fakeSpreadsheet_(today) {
  const properties = {values: {}, getProperty(k) { return this.values[k] || null; },
                      setProperty(k, v) { this.values[k] = String(v); return this; }};
  const spreadsheet = setupSheets(new MemorySpreadsheetApp('America/Los_Angeles'), properties).spreadsheet;

  const template = spreadsheet.getSheetByName('template');
  const header = readHeader(template);
  const values = template.getRange(2, 1, 1, header.length).getValues()[0]
    .map(v => String(v).replace(/\[([^\]\n]+)\]/g, (m, what) => `(fake ${what})`));
  template.getRange(2, 1, 1, header.length).setValues([values]);
  setOutreachEnabled(spreadsheet, true);

  const earlier = `${addDays(today, -3)} 07:12`;
  appendLeads(spreadsheet, [
    {contractor_id: 'FAKE-OLD-1', name: 'FAKE EARLIER ELECTRIC 1', email: 'hello@fake-earlier-1.example',
     zip_code: '00000', emailed_at: earlier, thread_id: 'fake-thread-old-1'},
    {contractor_id: 'FAKE-OLD-2', name: 'FAKE EARLIER ELECTRIC 2', email: 'gone@fake-earlier-2.example',
     zip_code: '00000', emailed_at: earlier, thread_id: 'fake-thread-old-2'},
    {contractor_id: 'FAKE-OLD-3', name: 'FAKE NEVER EMAILED ELECTRIC 3', email: 'later@fake-earlier-3.example',
     zip_code: '00000'},
  ]);
  const mailbox = [{threadId: 'fake-thread-old-2', from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
                    subject: 'Delivery Status Notification (Failure)', failedRecipients: 'gone@fake-earlier-2.example',
                    body: "Your message wasn't delivered to gone@fake-earlier-2.example (fake bounce)."}];
  return {spreadsheet, mailbox};
}
