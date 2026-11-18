/**
 * Turn Shovels contractor searches into filtered leads while spending as few credits as
 * possible. See docs/ingestion.md for why it works this way.
 *
 * We only need a steady supply of new leads, not every contractor, so each (state, day)
 * is searched at most once and whatever a run doesn't use is abandoned. Shovels ingests
 * permits in irregular batches, typically ~9 days late, and the newest day it has is
 * usually still filling in. So for each state a run asks the free coverage endpoint for
 * the newest day with any permits, treats that day as partial, and walks backward from
 * the day before, searching days not searched yet until it has enough leads.
 */

// No AK or HI: JoJoSpring can't ship there (see UNSHIPPABLE_STATES).
const US_STATES = [
  'AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

// The two contractor searches each run makes, sharing one lead target in any mix (see README
// "Targeting" and docs/ingestion.md). The GC search excludes electrical so the two never
// return the same contractor. The API silently ignores unknown values and still bills, so
// names here must match `shovels.exe contractors search --dry-run` exactly.
const LEAD_SEARCHES = [
  // Keeps the original required `electrical` permit tag.
  {name: 'electrician', classifications: ['electrical'], permitTags: ['electrical']},
  // No required tag: a GC's electrical work is often on the subcontractor's permit.
  {name: 'gc', classifications: ['general_building_contractor', '-electrical'], permitTags: []},
];

/**
 * LEAD_SEARCHES in the order a run on `today` uses: GCs first on even days of the month,
 * electricians first on odd days. The first search each day gets first pick of the run's
 * leads, so alternating keeps either kind from crowding out the other over a week.
 */
function searchesForDay(today) {
  const gcFirst = Number(String(today).slice(8, 10)) % 2 === 0;
  const byName = name => LEAD_SEARCHES.filter(search => search.name === name)[0];
  return gcFirst ? [byName('gc'), byName('electrician')] : [byName('electrician'), byName('gc')];
}
// Sent with every search, so Shovels does this filtering for free. A "-" excludes.
// Classification excludes drop any contractor with that trade anywhere in its list.
const EXCLUDED_CLASSIFICATIONS = ['general_engineering_contractor', 'roofing', 'concrete_and_paving',
                                  'landscaping_and_outdoor_work'];
// Tag excludes drop permits, not contractors. Only specialist jobs that never need decorative
// fixtures: remodels also carry tags like electric_meter, plumbing and hvac, so those stay.
const EXCLUDED_PERMIT_TAGS = ['solar', 'battery', 'ev_charger', 'generator', 'fire_sprinkler', 'telecom'];
const PROPERTY_TYPES = ['residential'];

/** The query params for one of LEAD_SEARCHES. */
function searchFilters(search) {
  return {
    contractor_classification_derived: search.classifications.concat(EXCLUDED_CLASSIFICATIONS.map(c => `-${c}`)),
    permit_tags: (search.permitTags || []).concat(EXCLUDED_PERMIT_TAGS.map(t => `-${t}`)),
    property_type: PROPERTY_TYPES,
  };
}

/** 'YYYY-MM-DD' plus n days (n may be negative). */
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Newest day in [oldest, today] that Shovels has any permits for, or null. Free: coverage calls only. */
function newestDayWithData(client, state, today, oldest) {
  for (let day = today; day >= oldest; day = addDays(day, -1)) {
    const total = client.permitsTotal(state, day, day);
    if (total === null || total > 0) return day;  // null: every field reliable, so there is data
  }
  return null;
}

/**
 * Find at least `targetLeads` new leads, from all searches together in any mix (fewer if the
 * lookback runs dry or maxContractors is hit). Returns {leads, outcomes}, where outcomes maps
 * every contractor id fetched to "lead" or the reason it was skipped. Leads carry more than
 * the leads tab stores (city, project_type, which search found them, the full contractor
 * record) so the send step can fill the template.
 *
 * Each (state, day) not searched yet gets each search in order, until the run has enough
 * leads. Only the run's last day can be left partly unread, as before.
 *
 * Every contractor returned is billed, so each page asks only for the leads still needed.
 * Every lead on a page that was paid for is kept, so a run can end with more than
 * targetLeads if the API ever returns more than asked; nothing paid for is thrown away.
 *
 * options:
 *   today          'YYYY-MM-DD' (required)
 *   blocklist      a Blocklist (required)
 *   knownLeads     rows already in the leads tab; their contractor_ids and emails are skipped
 *   searchLog      {state: {last_searched, days}}, mutated: days searched and when each state was visited
 *   days           lookback (default 30)
 *   targetLeads    default 10, across all searches
 *   searches       default searchesForDay(today): [{name, classifications, permitTags}], in the order run
 *   maxContractors cap on contractors fetched across all searches, so on credits, per run (default none)
 */
function fetchLeads(client, states, options) {
  const today = options.today;
  const blocklist = options.blocklist;
  const days = options.days || 30;
  const targetLeads = options.targetLeads || 10;
  const searches = options.searches || searchesForDay(today);
  const maxContractors = options.maxContractors || null;
  const maxContractorPermits = options.maxContractorPermits || MAX_CONTRACTOR_PERMITS;
  const searchLog = options.searchLog || {};
  const knownLeads = options.knownLeads || [];
  const oldest = addDays(today, -days);
  const leadIds = new Set(knownLeads.map(row => row.contractor_id).filter(Boolean));
  const leadEmails = new Set(knownLeads.map(row => String(row.email || '').toLowerCase()).filter(Boolean));
  const leads = [];
  const outcomes = {};
  const skipped = {};
  let fetched = 0;
  const found = {};  // leads per search name, for the log
  searches.forEach(search => { found[search.name] = 0; });

  const capped = () => Boolean(maxContractors && fetched >= maxContractors);
  const outOfBudget = () => leads.length >= targetLeads || capped();

  function consider(contractor, state, day, search) {
    fetched++;
    const cid = contractor.id;
    let reason;
    if (leadIds.has(cid)) {
      reason = 'already a lead';
    } else {
      reason = skipReason(contractor, maxContractorPermits, blocklist);
      if (!reason && leadEmails.has(contractor.primary_email.trim().toLowerCase())) reason = 'duplicate email';
    }
    outcomes[cid] = reason || 'lead';
    if (reason) {
      skipped[reason] = (skipped[reason] || 0) + 1;
      return;
    }
    const email = contractor.primary_email.trim().toLowerCase();
    leadIds.add(cid);
    leadEmails.add(email);
    found[search.name]++;
    leads.push({
      contractor_id: cid,
      name: contractor.business_name || contractor.name,
      email: email,
      phone: contractor.primary_phone || '',
      city: (contractor.address || {}).city || '',
      zip_code: (contractor.address || {}).zip_code || '',
      state: state,
      permit_date: day,
      project_type: projectType(contractor),
      search: search.name,
      contractor: contractor,
    });
  }

  /** Take one search's leads from one (state, day), a page at a time, until the run has enough or the day runs out. */
  function searchDay(search, state, day) {
    const before = fetched;
    const filters = searchFilters(search);
    let cursor = null;
    do {
      let size = Math.min(targetLeads - leads.length, PAGE_SIZE);
      // Shrink the last page so we aren't billed for records past maxContractors.
      if (maxContractors) size = Math.min(size, maxContractors - fetched);
      const page = client.searchContractorsPage(state, day, day, size, cursor, filters);
      // Look at the whole page, even past targetLeads: it's already paid for.
      page.items.forEach(contractor => consider(contractor, state, day, search));
      cursor = page.nextCursor;
    } while (cursor && !outOfBudget());
    console.log(`${state} ${day} ${search.name}: ${fetched - before} contractors, ` +
                `${leads.length} of ${targetLeads} leads so far`);
  }

  states = states.map(s => s.toUpperCase());
  const excluded = states.filter(s => UNSHIPPABLE_STATES.has(s));
  if (excluded.length) console.log(`skipping ${excluded.join(', ')}: JoJoSpring can't ship there`);
  states = states.filter(s => !UNSHIPPABLE_STATES.has(s));
  // Never-searched states first (''), then least recently searched; ties keep given order.
  const lastSearched = s => (searchLog[s] || {}).last_searched || '';
  states = states.map((s, i) => [s, i])
    .sort((a, b) => (lastSearched(a[0]) < lastSearched(b[0]) ? -1 : lastSearched(a[0]) > lastSearched(b[0]) ? 1 : a[1] - b[1]))
    .map(pair => pair[0]);

  try {
    for (const state of states) {
      if (outOfBudget()) break;
      const entry = searchLog[state] = searchLog[state] || {};
      // Stamp before searching so a state with no data still rotates to the back.
      entry.last_searched = today;
      // Days before the lookback are never reached again, so forget them.
      const searched = new Set((entry.days || []).filter(d => d >= oldest));
      entry.days = [...searched].sort();
      const newest = newestDayWithData(client, state, today, oldest);
      if (newest === null) {
        console.log(`${state}: no permits in the last ${days} days`);
        continue;
      }
      // The newest day with data is usually still filling in, so start the day before.
      for (let day = addDays(newest, -1); day >= oldest && !outOfBudget(); day = addDays(day, -1)) {
        if (searched.has(day)) continue;
        // Searched once, even if abandoned partway or it fails: there are always more days.
        searched.add(day);
        entry.days = [...searched].sort();
        for (const search of searches) {
          if (!outOfBudget()) searchDay(search, state, day);
        }
      }
    }
  } catch (e) {
    // Hand back what was found before the failure, so the caller can still save it.
    e.partial = {leads, outcomes};
    throw e;
  }

  if (maxContractors && fetched >= maxContractors) console.log(`reached maxContractors=${maxContractors}, stopping`);
  console.log(`${fetched} contractors fetched, ${leads.length} leads kept (${JSON.stringify(found)}); ` +
              `skipped: ${JSON.stringify(skipped)}`);
  return {leads, outcomes};
}

/** The contractor's most common permit tag besides "electrical", e.g. "new construction", or ''. */
function projectType(contractor) {
  const tally = contractor.tag_tally || {};
  const tags = Object.keys(tally).filter(tag => tag !== 'electrical')
    .sort((a, b) => (tally[b] - tally[a]) || (a < b ? -1 : 1));
  return tags.length ? tags[0].replace(/_/g, ' ') : '';
}
