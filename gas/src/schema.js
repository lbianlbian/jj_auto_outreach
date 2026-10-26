/**
 * The spreadsheet, declared in code. setupSheets() makes the real Sheet match this, and
 * store.js reads and writes columns by these header names, so moving or adding columns
 * by hand in the Sheet doesn't break anything. Mirrors docs/sheets.md; keep them in step.
 *
 * Changing a tab here and rerunning setup() adds missing tabs and columns. It never
 * deletes, renames or reorders anything, so renaming a column means doing it by hand.
 */

const SPREADSHEET_NAME = 'JoJoSpring outreach';
// Script Properties key holding the ID of the spreadsheet setupSheets() created.
const SPREADSHEET_ID_PROPERTY = 'SPREADSHEET_ID';

const SCHEMA = {
  // Leads, and the "don't contact again" list: ingestion skips any contractor_id or email
  // already here. Kept minimal on purpose; anything else can be looked up in Shovels by id.
  leads: {
    columns: ['contractor_id', 'emailed_at', 'name', 'email'],
  },
  // Days already searched per state, as inclusive date ranges. A state with no data gets
  // a row with blank start/end so searched_at still rotates it to the back.
  search_log: {
    columns: ['state', 'start', 'end', 'searched_at'],
  },
  // Companies and email domains never to pitch. The two columns are independent lists.
  blocklist: {
    columns: ['company', 'email_domain'],
    // Written only when the tab is first created; after that the tab is hand-edited.
    seed: {
      company: [
        'Tesla', 'SolarCity', 'Sunrun', 'Vivint Solar', 'SunPower', 'Sunnova', 'Freedom Forever',
        'Momentum Solar', 'Trinity Solar', 'Palmetto Solar', 'Blue Raven Solar', 'ADT Solar',
        'SunPro Solar', 'Titan Solar', 'Sunworks', 'Semper Solaris', 'Generac', 'Home Depot',
        "Lowe's", 'Rosendin', 'Cupertino Electric', 'Bergelectric', 'IES Commercial',
        'Integrated Electrical Services', 'MYR Group', 'Quanta Services', 'EMCOR',
        'Comfort Systems USA', 'Comcast', 'AT&T', 'Verizon', 'Charter Communications',
        'Pacific Gas and Electric', 'Southern California Edison', 'San Diego Gas & Electric',
        'Arizona Public Service', 'PCL Construction', 'Sundt Construction', 'Vector Security',
      ],
      email_domain: [
        'ipermitca.com', 'tesla.com', 'solarcity.com', 'sunrun.com', 'vivintsolar.com',
        'sunpower.com', 'sunnova.com', 'freedomforever.com', 'momentumsolar.com',
        'trinitysolar.com', 'homedepot.com', 'aps.com', 'pcl.com', 'sundt.com',
        'vectorsecurity.com', 'email.com', 'example.com', 'test.com', 'none.com',
        'noemail.com', 'jccal.org',
      ],
    },
  },
  // One cell, A2: "yes" lets automatic outreach run, anything else stops it. Starts at "no"
  // so nothing runs on its own until it's turned on by hand. Not read by any code yet (JJ-13).
  kill_switch: {
    columns: ['Continue automatic outreach?'],
    seed: {'Continue automatic outreach?': ['no']},
  },
};
