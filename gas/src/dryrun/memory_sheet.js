/**
 * An in-memory spreadsheet with the slice of the SpreadsheetApp API that src/ uses. The dry
 * run copies the real Sheet into one, so the pipeline reads real tabs but writes go
 * nowhere. Every write calls onWrite({tab, row, col, before, after}) with the cell values
 * before and after, which is how the dry run describes Sheet changes without knowing which
 * code made them. If src/ starts calling a method that isn't here, the dry run fails with
 * "... is not a function": add the method here.
 */

class MemoryRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet.get(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }

  getValue() { return this.getValues()[0][0]; }

  setValues(values) {
    if (values.length !== this.numRows || values.some(line => line.length !== this.numCols)) {
      throw new Error(`setValues: ${values.length} rows into a range of ${this.numRows}x${this.numCols}`);
    }
    const before = this.getValues();
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    this.sheet.parent.onWrite({tab: this.sheet.name, row: this.row, col: this.col, before, after: this.getValues()});
    return this;
  }

  setValue(value) { return this.setValues([[value]]); }

  clearContent() {
    return this.setValues(Array.from({length: this.numRows}, () => Array(this.numCols).fill('')));
  }

  // Formatting isn't data, so the dry run ignores it.
  setFontWeight() { return this; }
  setNumberFormat() { return this; }
}

class MemorySheet {
  constructor(name, parent) {
    this.name = name;
    this.parent = parent;
    this.cells = [];  // cells[row - 1][col - 1]
    this.maxRows = 1000;
  }

  getName() { return this.name; }
  getParent() { return this.parent; }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, howMany) { this.maxRows += howMany; }
  setFrozenRows() {}

  get(row, col) {
    const v = (this.cells[row - 1] || [])[col - 1];
    return v === undefined || v === null ? '' : v;
  }

  set(row, col, value) {
    while (this.cells.length < row) this.cells.push([]);
    this.cells[row - 1][col - 1] = value;
  }

  getLastRow() {
    for (let r = this.cells.length; r > 0; r--) {
      if (this.cells[r - 1].some(v => v !== '' && v !== undefined && v !== null)) return r;
    }
    return 0;
  }

  getLastColumn() {
    let last = 0;
    this.cells.forEach(line => {
      for (let c = line.length; c > last; c--) {
        if (line[c - 1] !== '' && line[c - 1] !== undefined && line[c - 1] !== null) { last = c; break; }
      }
    });
    return last;
  }

  getRange(row, col, numRows, numCols) {
    numRows = numRows || 1;
    numCols = numCols || 1;
    if (row < 1 || col < 1 || row + numRows - 1 > this.maxRows) throw new Error('Range is outside the sheet');
    return new MemoryRange(this, row, col, numRows, numCols);
  }

  getDataRange() {
    return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }

  /** Every row, header included, as arrays. */
  allValues() {
    const rows = this.getLastRow();
    const cols = this.getLastColumn();
    return rows && cols ? this.getRange(1, 1, rows, cols).getValues() : [];
  }
}

class MemorySpreadsheet {
  constructor(name, timeZone) {
    this.name = name;
    this.timeZone = timeZone || 'America/Los_Angeles';
    this.sheets = [];
    this.onWrite = () => {};
  }

  getId() { return 'dry-run-in-memory'; }
  getName() { return this.name; }
  getUrl() { return '(dry run: in-memory copy, not a real spreadsheet)'; }
  getSpreadsheetTimeZone() { return this.timeZone; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.find(s => s.name === name) || null; }

  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists`);
    const sheet = new MemorySheet(name, this);
    this.sheets.push(sheet);
    return sheet;
  }

  deleteSheet(sheet) { this.sheets = this.sheets.filter(s => s !== sheet); }
}

/** Stand-in for SpreadsheetApp that makes MemorySpreadsheets, for setupSheets() in a dry run. */
class MemorySpreadsheetApp {
  constructor(timeZone) {
    this.timeZone = timeZone;
    this.files = {};
  }

  create(name) {
    const ss = new MemorySpreadsheet(name, this.timeZone);
    this.files[ss.getId()] = ss;
    return ss;
  }

  openById(id) {
    if (!this.files[id]) throw new Error(`Requested entity was not found: ${id}`);
    return this.files[id];
  }
}

/**
 * A MemorySpreadsheet holding every tab and value of `source` (real or in-memory). Reads
 * only: nothing is written to source.
 */
function copySpreadsheet_(source) {
  const copy = new MemorySpreadsheet(source.getName ? source.getName() : 'copy', source.getSpreadsheetTimeZone());
  source.getSheets().forEach(sheet => {
    const target = copy.insertSheet(sheet.getName());
    const rows = sheet.getLastRow();
    const cols = sheet.getLastColumn();
    if (rows && cols) {
      sheet.getRange(1, 1, rows, cols).getValues()
        .forEach((line, r) => line.forEach((v, c) => { if (v !== '') target.set(r + 1, c + 1, v); }));
    }
    target.maxRows = Math.max(target.maxRows, rows);
  });
  return copy;
}
