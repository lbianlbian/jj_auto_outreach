/**
 * Dry runs: run the real pipeline code against fakes and describe every action it would
 * take. The fakes sit at the services boundary (liveServices_ in main.js), not inside any
 * stage, so the dry run doesn't know what the stages do. Each one is described by its
 * effects: HTTP calls (with their Shovels credit cost), emails, mailbox searches and Sheet
 * writes, then the net change to every tab. A stage that changes, or a new one, shows up
 * with no change here, as long as it reaches the outside world only through `services`.
 *
 * Entry points: dryRun() in main.js (the real Sheet, copied), and `npm run dry-run` in
 * gas/ (a fake Sheet from fakeSpreadsheet_, fully offline).
 */

// What a dry run can run: name -> function(services). Add an entry point here to dry-run it.
const DRY_RUN_ENTRIES = {
  dailyRun: services => dailyRunWith_(services),
  sendPendingEmails: services => sendPending_(services, []),
  checkBounces: services => checkBounces_(services),
};

/**
 * Run entry(services) against an in-memory copy of `source` and fakes for everything else.
 * Reads source, never writes it. Prints each action as it happens, then a summary.
 * options:
 *   today(), now()       clock, as in liveServices_ (default: this machine's clock)
 *   world                fakeWorld_ (default: a fresh one for today)
 *   pretendOutreachOn    if the copy's kill switch isn't "yes", set it to "yes" (default true)
 *   print(text)          where output goes (default console.log)
 * Returns {notes, actions, emails, sheetChanges, result, error}. The run's error, if any,
 * is reported, not thrown.
 */
function runDry_(entry, source, options) {
  options = options || {};
  const print = options.print || (text => console.log(text));
  const today = options.today || (() => localStamp_(new Date()).slice(0, 10));
  const now = options.now || (() => localStamp_(new Date()));
  const world = options.world || fakeWorld_(today());
  const report = {notes: [], actions: [], emails: [], sheetChanges: [], result: undefined, error: null};

  // Consecutive actions with the same group (e.g. 30 coverage checks) print as one line.
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const line = pending.count > 1 ? `${pending.line} (x${pending.count})` : pending.line;
    report.actions.push(line);
    print(`[dry run] ${line}`);
    pending = null;
  };
  const say = (line, group) => {
    if (group && pending && pending.group === group) { pending.count++; return; }
    flush();
    pending = {line, group, count: 1};
    if (!group) flush();
  };

  const spreadsheet = copySpreadsheet_(source);
  if (options.pretendOutreachOn !== false && !outreachEnabled(spreadsheet)) {
    setOutreachEnabled(spreadsheet, true);
    report.notes.push('The kill switch is not "yes" in the Sheet; the dry run pretends it is, so the run does something.');
  }
  const before = snapshotSheet_(spreadsheet);
  spreadsheet.onWrite = event => {
    const line = describeWrite_(event, readHeader(spreadsheet.getSheetByName(event.tab)),
                                row => spreadsheet.getSheetByName(event.tab).get(row, 1));
    if (line) say(line);
  };

  const services = {
    spreadsheet: spreadsheet,
    fetch: (url, headers) => {
      let answer;
      try {
        answer = world.request(url, headers);
      } catch (e) {
        // Code under test may swallow fetch errors (hasMailServer does), so record it here too.
        report.notes.push(`Unfaked outside call: ${e.message}`);
        say(`HTTP ${url}: ${e.message}`);
        throw e;
      }
      say(answer.description, answer.group);
      return answer.response;
    },
    sleep: ms => say(`wait ${ms / 1000}s (skipped)`),
    today: today,
    now: now,
    sendMail: (to, subject, body) => {
      const threadId = `dry-run-thread-${report.emails.length + 1}`;
      report.emails.push({to, subject, body, thread_id: threadId});
      say(`email to ${to}: "${subject}" (not sent; full text below)`);
      return threadId;
    },
    searchMail: (query, max) => {
      const found = world.searchMail(query, max);
      say(`Gmail search "${query.length > 60 ? `${query.slice(0, 57)}...` : query}": ` +
          `${found.length} message(s) in the fake mailbox`);
      return found;
    },
    shovelsApiKey: 'dry-run-fake-key',
  };

  print('[dry run] start: fakes for Shovels, DNS and Gmail; Sheet writes go to an in-memory copy');
  try {
    report.result = entry(services);
  } catch (e) {
    report.error = e.message;
    say(`the run would stop with an error: ${e.message}`);
  }
  flush();
  report.sheetChanges = diffSheets_(before, snapshotSheet_(spreadsheet));
  formatDryRun_(report).forEach(section => print(section));
  return report;
}

/** runDry_ on a fake Sheet (fakeSpreadsheet_), for running offline. entryName: a DRY_RUN_ENTRIES key. */
function dryRunOnFakeSheet_(entryName, options) {
  options = options || {};
  const entry = DRY_RUN_ENTRIES[entryName || 'dailyRun'];
  if (!entry) throw new Error(`No dry run for "${entryName}". Choose one of: ${Object.keys(DRY_RUN_ENTRIES).join(', ')}.`);
  const today = options.today || (() => localStamp_(new Date()).slice(0, 10));
  const fake = fakeSpreadsheet_(today());
  return runDry_(entry, fake.spreadsheet, Object.assign({
    today: today,
    world: fakeWorld_(today(), {mailbox: fake.mailbox}),
  }, options));
}

/** One line for a Sheet write, or null if it changed nothing. rowKey(row) is the row's first cell. */
function describeWrite_(event, header, rowKey) {
  const changed = [];
  event.after.forEach((line, i) => {
    const cols = line.map((v, j) => j).filter(j => String(line[j]) !== String(event.before[i][j]));
    if (cols.length) changed.push({row: event.row + i, i, cols});
  });
  if (!changed.length) return null;
  const tab = `Sheet ${event.tab}`;
  const name = j => header[event.col - 1 + j] || `column ${event.col + j}`;
  const blank = line => line.every(v => v === '' || v === null || v === undefined);
  if (event.row === 1) return `${tab}: header ${event.after[0].filter(v => v !== '').join(', ')}`;
  const first = changed[0].row;
  const last = changed[changed.length - 1].row;
  if (changed.length > 1) {
    if (changed.every(c => blank(event.before[c.i]))) return `${tab}: add rows ${first}-${last} (${changed.length} rows)`;
    if (changed.every(c => blank(event.after[c.i]))) return `${tab}: clear rows ${first}-${last}`;
    return `${tab}: rewrite rows ${first}-${last} (${changed.length} rows change)`;
  }
  const {i, cols} = changed[0];
  if (blank(event.before[i]) && event.col === 1) {
    return `${tab}: add row ${first}: ${cols.map(j => `${name(j)}=${event.after[i][j]}`).join(', ')}`;
  }
  const key = rowKey(first);
  return `${tab}: row ${first}${key && event.col !== 1 ? ` (${key})` : ''}: ` +
    cols.map(j => `${name(j)} "${event.before[i][j]}" -> "${event.after[i][j]}"`).join(', ');
}

/** {tab: {header, rows: [[cell text]]}} for every tab. */
function snapshotSheet_(spreadsheet) {
  const snap = {};
  spreadsheet.getSheets().forEach(sheet => {
    const [header = [], ...rows] = sheet.allValues().map(line => line.map(v => String(v)));
    snap[sheet.getName()] = {header, rows: rows.filter(line => line.some(v => v !== ''))};
  });
  return snap;
}

/**
 * The net change per tab, as text lines: "+" rows added, "-" rows removed, "~" rows whose
 * first cell (contractor_id on leads) matches one removed row and one added row.
 */
function diffSheets_(before, after) {
  const lines = [];
  Object.keys(after).forEach(tab => {
    const header = after[tab].header;
    const old = before[tab] || {header: [], rows: []};
    const asObj = (hdr, line) => { const o = {}; hdr.forEach((h, k) => { o[h] = line[k] || ''; }); return o; };
    const keyOf = o => JSON.stringify(header.map(h => o[h] || ''));
    const counts = {};
    old.rows.map(line => asObj(old.header, line)).forEach(o => { counts[keyOf(o)] = (counts[keyOf(o)] || 0) + 1; });
    const added = [];
    after[tab].rows.map(line => asObj(header, line)).forEach(o => {
      if (counts[keyOf(o)]) counts[keyOf(o)]--;
      else added.push(o);
    });
    const removed = [];
    old.rows.map(line => asObj(old.header, line)).forEach(o => {
      if (counts[keyOf(o)]) { counts[keyOf(o)]--; removed.push(o); }
    });

    const id = header[0];
    const only = (list, value) => list.filter(o => o[id] === value).length === 1;
    const changed = added.filter(o => o[id] && only(added, o[id]) && only(removed, o[id]));
    const out = [];
    changed.forEach(o => {
      const was = removed.find(r => r[id] === o[id]);
      const diffs = header.filter(h => (was[h] || '') !== (o[h] || '')).map(h => `${h} "${was[h] || ''}" -> "${o[h]}"`);
      out.push(`  ~ ${o[id]}: ${diffs.join(', ')}`);
    });
    const show = o => header.filter(h => o[h] !== '').map(h => `${h}=${o[h]}`).join(', ');
    added.filter(o => changed.indexOf(o) === -1).forEach(o => out.push(`  + ${show(o)}`));
    removed.filter(o => !changed.some(c => c[id] === o[id])).forEach(o => out.push(`  - ${show(o)}`));
    if (out.length) lines.push(`${tab}${before[tab] ? '' : ' (new tab)'}:`, ...out);
  });
  return lines.length ? lines : ['(no changes)'];
}

/** The summary printed after a dry run, as sections (separate log lines keep each one small). */
function formatDryRun_(report) {
  const sections = [[
    '===== DRY RUN SUMMARY =====',
    'Nothing was sent, nothing was written to the real Sheet, and no Shovels credits were spent.',
    ...report.notes.map(n => `Note: ${n}`),
    report.error ? `The run would fail: ${report.error}` : `Result: ${JSON.stringify(report.result)}`,
  ].join('\n')];
  sections.push(`----- ${report.emails.length} email(s) that would be sent -----`);
  // The first email in full; later ones only where they differ from it, since most of a
  // templated email is the same for every lead.
  const firstLines = report.emails.length ? report.emails[0].body.split('\n') : [];
  report.emails.forEach((email, i) => {
    const lines = email.body.split('\n');
    let body = email.body;
    if (i > 0 && lines.length === firstLines.length) {
      const diffs = lines.map((line, k) => [k, line]).filter(([k, line]) => line !== firstLines[k]);
      body = diffs.length ? `(same body as [1] except)\n${diffs.map(([k, line]) => `  line ${k + 1}: ${line}`).join('\n')}`
                          : '(same body as [1])';
    }
    sections.push([`[${i + 1}] To: ${email.to}`, `Subject: ${email.subject}`, '', body, ''].join('\n'));
  });
  sections.push(['----- Sheet rows that would change -----', ...report.sheetChanges].join('\n'));
  return sections;
}

/** 'yyyy-MM-dd HH:mm' in this machine's time zone. */
function localStamp_(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
