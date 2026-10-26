/** Decide whether a contractor is a usable lead: shipping, size, blocklist and email checks. Port of filters.py. */

// Contractors with more lifetime permits than this are national/large firms (e.g. Tesla
// has ~75k), not the small shops we're pitching to.
const MAX_CONTRACTOR_PERMITS = 500;
const JUNK_EMAIL_LOCALPARTS = new Set(['no', 'none', 'na', 'n/a', 'noemail', 'test', 'null']);
// JoJoSpring can't ship to these states, so contractors there are never leads.
const UNSHIPPABLE_STATES = new Set(['AK', 'HI']);

/** Uppercase, '&' -> 'AND', other punctuation dropped, so "AT&T" matches "A T & T"-style variants. */
function normalizeName_(name) {
  name = String(name || '').toUpperCase().replace(/&/g, ' AND ');
  return name.replace(/[^A-Z0-9 ]+/g, '').split(/\s+/).filter(Boolean).join(' ');
}

/** Big companies and email domains to never pitch. Build one with store.loadBlocklist(). */
class Blocklist {
  constructor(companies, emailDomains) {
    const names = [...new Set((companies || []).map(normalizeName_).filter(Boolean))].sort();
    const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // Whole-word match so "ADT SOLAR" doesn't block "BRADT SOLAR".
    this.names = names.length ? new RegExp(`\\b(${escaped.join('|')})\\b`) : null;
    this.emailDomains = new Set((emailDomains || []).map(d => String(d).trim().toLowerCase()));
  }

  blocksCompany(contractor) {
    if (!this.names) return false;
    return ['business_name', 'name', 'dba'].some(field => this.names.test(normalizeName_(contractor[field])));
  }
}

/** Why this contractor isn't a usable lead, or null if it is. */
function skipReason(contractor, maxContractorPermits, blocklist) {
  // Permits are searched per state, but the contractor's own address is where we'd ship.
  if (UNSHIPPABLE_STATES.has(String((contractor.address || {}).state || '').toUpperCase())) {
    return 'unshippable state';
  }
  if ((contractor.permit_count || 0) > maxContractorPermits) return 'too large';
  if (blocklist.blocksCompany(contractor)) return 'blocklisted company';
  const email = String(contractor.primary_email || '').trim().toLowerCase();
  const at = email.indexOf('@');
  const local = at === -1 ? email : email.slice(0, at);
  const domain = at === -1 ? '' : email.slice(at + 1);
  if (!local || domain.indexOf('.') === -1) return 'no primary email';
  // .gov addresses are permit offices and other agencies, not contractors.
  if (blocklist.emailDomains.has(domain) || domain.endsWith('.gov') || JUNK_EMAIL_LOCALPARTS.has(local)) {
    return 'blocked email';
  }
  return null;
}
