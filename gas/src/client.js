/**
 * Thin client for the Shovels v2 API, tracking credits spent. Port of client.py.
 * Credits are billed per record returned, not per request; see ingestion/CLAUDE.md.
 *
 * HTTP goes through an injected fetch(url, headers) -> {status, headers, body}, with
 * header names lowercased, so tests can pass a fake API. main.js passes UrlFetchApp.
 */

const SHOVELS_BASE_URL = 'https://api.shovels.ai/v2';
// Upper bound on page size; fetchLeads shrinks pages further to what it still needs.
const PAGE_SIZE = 25;
const MAX_RETRIES = 5;

class ShovelsClient {
  constructor(apiKey, fetch, sleep) {
    this.apiKey = apiKey;
    this.fetch = fetch;
    this.sleep = sleep || (() => {});
    this.creditsUsed = 0;
    this.creditsRemaining = null;
  }

  /** GET with retry/backoff on 429 and 5xx. */
  get_(path, params) {
    const url = `${SHOVELS_BASE_URL}${path}?${toQuery_(params)}`;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const resp = this.fetch(url, {'X-API-Key': this.apiKey, 'Accept': 'application/json'});
      if (resp.status === 429 || resp.status >= 500) {
        const wait = Number(resp.headers['retry-after'] || 2 ** attempt);
        console.warn(`HTTP ${resp.status} on ${path}, retrying in ${wait}s`);
        this.sleep(wait * 1000);
        continue;
      }
      if (resp.status >= 400) throw new Error(`HTTP ${resp.status} on ${path}: ${String(resp.body).slice(0, 300)}`);
      // Responses that return no records carry no credit headers.
      this.creditsUsed += Number(resp.headers['x-credits-request'] || 0);
      if (resp.headers['x-credits-remaining'] !== undefined) {
        this.creditsRemaining = Number(resp.headers['x-credits-remaining']);
      }
      return JSON.parse(resp.body);
    }
    throw new Error(`${path} still failing after ${MAX_RETRIES} tries`);
  }

  /**
   * One page of contractors with a matching permit filed in [from, to]: {items, nextCursor}.
   * Results are sorted by contractor id, and each contractor appears once however many
   * permits it filed. Every item returned costs 1 credit.
   */
  searchContractorsPage(geoId, from, to, size, cursor) {
    if (!(size >= 1)) throw new Error(`page size must be at least 1, got ${size}`);
    const params = {
      geo_id: geoId,
      permit_from: from,
      permit_to: to,
      permit_tags: ['electrical'],
      // The API silently ignores unknown params, so this name must stay exact.
      contractor_classification_derived: ['electrical'],
      size: size,
    };
    if (cursor) params.cursor = cursor;
    const body = this.get_('/contractors/search', params);
    return {items: body.items || [], nextCursor: body.next_cursor || null};
  }

  /**
   * Count of all permits (any type) in the window, from the credit-exempt coverage endpoint.
   * Returns null when every tracked field is reliably filled, since the endpoint then
   * returns no items to carry the count.
   */
  permitsTotal(geoId, from, to) {
    const body = this.get_('/meta/coverage', {geo_id: geoId, geo_type: 'state', date_from: from, date_to: to});
    const items = body.items || [];
    return items.length ? items[0].permits_total : null;
  }
}

/** Query string with list params sent as repeated keys (permit_tags=a&permit_tags=b), as the API expects. */
function toQuery_(params) {
  const parts = [];
  Object.keys(params).forEach(key => {
    [].concat(params[key]).forEach(value => {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    });
  });
  return parts.join('&');
}
