// In-memory stand-ins for SpreadsheetApp, Script Properties and the Shovels HTTP API.

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, {sheet, row, col, numRows, numCols});
  }

  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = this.sheet.cells[this.row - 1 + r] || [];
      out.push(Array.from({length: this.numCols}, (_, c) => {
        const v = line[this.col - 1 + c];
        return v === undefined ? '' : v;
      }));
    }
    return out;
  }

  setValues(values) {
    if (values.length !== this.numRows || values.some(v => v.length !== this.numCols)) {
      throw new Error(`setValues: ${values.length}x${values[0].length} into ${this.numRows}x${this.numCols}`);
    }
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return this;
  }

  clearContent() {
    return this.setValues(Array.from({length: this.numRows}, () => Array(this.numCols).fill('')));
  }

  setFontWeight() { return this; }

  setNumberFormat(format) {
    this.sheet.formats.push({row: this.row, numRows: this.numRows, format});
    return this;
  }
}

class FakeSheet {
  constructor(name, parent) {
    Object.assign(this, {name, parent, cells: [], maxRows: 1000, frozenRows: 0, formats: []});
  }

  getName() { return this.name; }
  getParent() { return this.parent; }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, howMany) { this.maxRows += howMany; }
  setFrozenRows(n) { this.frozenRows = n; }

  set(row, col, value) {
    while (this.cells.length < row) this.cells.push([]);
    this.cells[row - 1][col - 1] = value;
  }

  getLastRow() {
    for (let r = this.cells.length; r > 0; r--) {
      if (this.cells[r - 1].some(v => v !== '' && v !== undefined)) return r;
    }
    return 0;
  }

  getLastColumn() {
    return Math.max(0, ...this.cells.map(line => {
      for (let c = line.length; c > 0; c--) if (line[c - 1] !== '' && line[c - 1] !== undefined) return c;
      return 0;
    }));
  }

  getRange(row, col, numRows = 1, numCols = 1) {
    if (row + numRows - 1 > this.maxRows) throw new Error('Range is outside the sheet');
    return new FakeRange(this, row, col, numRows, numCols);
  }

  /** Test helper: every row as an array, header included. */
  rows() {
    return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()).getValues();
  }
}

class FakeSpreadsheet {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.sheets = [new FakeSheet('Sheet1', this)];
  }

  getId() { return this.id; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; }
  getSpreadsheetTimeZone() { return 'America/Los_Angeles'; }
  getSheets() { return [...this.sheets]; }
  getSheetByName(name) { return this.sheets.find(s => s.name === name) || null; }

  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists`);
    const sheet = new FakeSheet(name, this);
    this.sheets.push(sheet);
    return sheet;
  }

  deleteSheet(sheet) { this.sheets = this.sheets.filter(s => s !== sheet); }
}

class FakeSpreadsheetApp {
  constructor() { this.files = {}; }

  create(name) {
    const ss = new FakeSpreadsheet(`ss${Object.keys(this.files).length + 1}`, name);
    this.files[ss.id] = ss;
    return ss;
  }

  openById(id) {
    if (!this.files[id]) throw new Error(`Requested entity was not found: ${id}`);
    return this.files[id];
  }
}

class FakeProperties {
  constructor(values = {}) { this.values = {...values}; }
  getProperty(key) { return key in this.values ? this.values[key] : null; }
  setProperty(key, value) { this.values[key] = String(value); return this; }
}

const LIST_PARAMS = ['permit_tags', 'contractor_classification_derived'];

function contractor(i, overrides = {}) {
  return {id: `C${String(i).padStart(2, '0')}`, business_name: `Shop ${i}`, primary_email: `x${i}@shop${i}.com`,
          permit_count: 5, classification_derived: ['electrical'], ...overrides};
}

/**
 * Serves /contractors/search sorted by id with a keyset cursor, and /meta/coverage counts,
 * over fake HTTP. Bills 1 credit per contractor returned, the way the real API does;
 * coverage and empty responses are free.
 */
class FakeShovels {
  constructor() {
    this.contractors = {};
    [
      contractor(1),
      contractor(2, {permit_count: 74859}),
      contractor(3, {primary_email: 'north@ipermitca.com'}),
      contractor(4, {primary_email: 'no@foo.com'}),
      contractor(5, {primary_email: 'x1@shop1.com'}),  // same email as C01
      contractor(6, {business_name: 'Sunrun Inc'}),
      contractor(31, {address: {state: 'HI'}}),  // works in CA, based in Hawaii
      ...Array.from({length: 23}, (_, k) => contractor(k + 7)),
      contractor(90, {business_name: 'Cool Air HVAC', classification_derived: ['hvac']}),
    ].forEach(c => { this.contractors[c.id] = c; });
    this.permits = {};  // {geo: {day: [contractor ids]}}
    this.addPermits('CA', '2026-10-12', [20, 21]);  // newest day: partial, must be skipped
    this.addPermits('CA', '2026-10-11', [1, 1, 2, 3, 4, 5, 6, 7, 8, 90, 27, 28, 31]);
    this.addPermits('CA', '2026-10-10', [1, 9, 10, 11, 12, 13]);  // C01 again: a lead after run 1
    this.addPermits('CA', '2026-10-09', [14, 15, 16, 17, 18, 19]);
    // Test knobs: return at least this many records per page, and fail the Nth search (1 = first).
    this.minPage = 0;
    this.failOnSearch = null;
    this.reset();
    this.fetch = this.fetch.bind(this);
  }

  addPermits(geo, day, ids) {
    const days = this.permits[geo] = this.permits[geo] || {};
    days[day] = (days[day] || []).concat(ids.map(i => `C${String(i).padStart(2, '0')}`));
  }

  reset() {
    this.calls = [];
    this.returned = [];  // contractor ids billed, in order
  }

  get billed() { return this.returned.length; }

  inWindow(geo, start, end) {
    return Object.entries(this.permits[geo] || {})
      .filter(([day]) => start <= day && day <= end).flatMap(([, ids]) => ids);
  }

  fetch(url, headers) {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/v2/, '');
    const params = {};
    for (const key of new Set(parsed.searchParams.keys())) {
      params[key] = LIST_PARAMS.includes(key) ? parsed.searchParams.getAll(key) : parsed.searchParams.get(key);
    }
    this.calls.push({path, params, headers});
    if (path === '/meta/coverage') {
      const total = this.inWindow(params.geo_id, params.date_from, params.date_to).length;
      return json({items: [{field: 'fees', tier: 'missing', permits_total: total}]});
    }
    if (path !== '/contractors/search') return {status: 404, headers: {}, body: '{"detail":"Not Found"}'};
    if (this.failOnSearch !== null && this.searched().length === this.failOnSearch) {
      return {status: 400, headers: {}, body: '{"detail":"boom"}'};
    }
    const size = Number(params.size);
    if (!(size >= 1)) return {status: 422, headers: {}, body: '{"detail":"size must be >= 1"}'};
    const wanted = params.contractor_classification_derived || [];
    let ids = [...new Set(this.inWindow(params.geo_id, params.permit_from, params.permit_to))]
      .filter(cid => wanted.every(w => this.contractors[cid].classification_derived.includes(w)))
      .sort();
    ids = ids.filter(cid => cid > (params.cursor || ''));
    const page = ids.slice(0, Math.max(size, this.minPage));
    this.returned.push(...page);
    return json({items: page.map(cid => this.contractors[cid]),
                 next_cursor: ids.length > page.length ? page[page.length - 1] : null},
                page.length ? {'x-credits-request': String(page.length), 'x-credits-remaining': '70'} : {});
  }

  /** [geo, day] of each paid search request, in order. */
  searched() {
    return this.calls.filter(c => c.path === '/contractors/search').map(c => [c.params.geo_id, c.params.permit_from]);
  }
}

function json(body, headers = {}) {
  return {status: 200, headers, body: JSON.stringify(body)};
}

module.exports = {FakeSpreadsheetApp, FakeProperties, FakeShovels, contractor};
