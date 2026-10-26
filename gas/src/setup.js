/**
 * Make the spreadsheet match SCHEMA, creating it on the first run. Safe to rerun: it only
 * adds what's missing (the spreadsheet, tabs, header columns) and never touches existing
 * rows, so data typed or written into the Sheet survives.
 *
 * Takes the SpreadsheetApp and Script Properties services as arguments so tests can pass
 * fakes. Returns {spreadsheet, created, changes}, where changes lists what was added.
 */
function setupSheets(spreadsheetApp, properties, schema) {
  schema = schema || SCHEMA;
  const changes = [];
  const id = properties.getProperty(SPREADSHEET_ID_PROPERTY);
  let spreadsheet;
  if (id) {
    try {
      spreadsheet = spreadsheetApp.openById(id);
    } catch (e) {
      // Don't quietly make a second spreadsheet: that would split the data in two.
      throw new Error(`Can't open spreadsheet ${id} (${e.message}). If it was deleted on purpose, ` +
                      `remove the ${SPREADSHEET_ID_PROPERTY} script property and run setup again.`);
    }
  } else {
    spreadsheet = spreadsheetApp.create(SPREADSHEET_NAME);
    properties.setProperty(SPREADSHEET_ID_PROPERTY, spreadsheet.getId());
    changes.push(`created spreadsheet "${SPREADSHEET_NAME}"`);
  }
  const defaultTabs = id ? [] : spreadsheet.getSheets();

  Object.keys(schema).forEach(name => {
    const tab = schema[name];
    let sheet = spreadsheet.getSheetByName(name);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(name);
      changes.push(`created tab ${name}`);
      writeHeader_(sheet, tab.columns);
      if (tab.seed) {
        const rows = seedRows_(tab);
        sheet.getRange(2, 1, rows.length, tab.columns.length).setValues(rows);
        changes.push(`seeded ${name} with ${rows.length} rows`);
      }
      return;
    }
    const header = readHeader(sheet);
    const missing = tab.columns.filter(column => header.indexOf(column) === -1);
    if (missing.length) {
      // Append at the right so existing columns, and the data under them, stay put.
      const start = header.length + 1;
      sheet.getRange(1, start, 1, missing.length).setValues([missing]).setFontWeight('bold');
      changes.push(`added columns to ${name}: ${missing.join(', ')}`);
    }
  });

  // A new spreadsheet comes with an empty "Sheet1"; drop it once our tabs exist.
  defaultTabs.forEach(sheet => {
    if (!schema[sheet.getName()]) spreadsheet.deleteSheet(sheet);
  });
  return {spreadsheet, created: !id, changes};
}

/** Header names in row 1, trimmed, up to the last non-empty one. */
function readHeader(sheet) {
  const width = sheet.getLastColumn();
  if (!width) return [];
  const header = sheet.getRange(1, 1, 1, width).getValues()[0].map(v => String(v).trim());
  while (header.length && !header[header.length - 1]) header.pop();
  return header;
}

function writeHeader_(sheet, columns) {
  sheet.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

/** Seed lists side by side: row i holds the i-th value of each column, '' once a list runs out. */
function seedRows_(tab) {
  const height = Math.max(...tab.columns.map(c => (tab.seed[c] || []).length));
  const rows = [];
  for (let i = 0; i < height; i++) {
    rows.push(tab.columns.map(c => (tab.seed[c] || [])[i] || ''));
  }
  return rows;
}
