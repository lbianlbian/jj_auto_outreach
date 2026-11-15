/**
 * The HTML dashboard: a read-only summary of the Sheet for the owner, served by doGet() in
 * main.js. dashboardData() does the counting (tested offline); renderDashboard() turns it
 * into a page. It reads through store.js only and never calls Shovels or Gmail, so opening
 * it costs nothing. Editing (template, blocklist, kill switch) stays in the Sheet.
 */

// Days of sends shown in the chart, and how many recent runs and leads are listed.
const DASHBOARD_DAYS = 14;
const DASHBOARD_ROWS = 10;
// Shovels' credit limit is a rolling 30-day window.
const CREDIT_WINDOW_DAYS = 30;
// The web app is public ("Anyone"), so the page shows only to a request carrying this
// Script Property as ?key=... setup() makes it once and logs the link; resetDashboardKey() revokes it.
const DASHBOARD_KEY_PROPERTY = 'DASHBOARD_KEY';

/** The stored dashboard key, made with makeKey() and saved the first time. Never replaces one. */
function ensureDashboardKey(properties, makeKey) {
  if (!properties.getProperty(DASHBOARD_KEY_PROPERTY)) properties.setProperty(DASHBOARD_KEY_PROPERTY, makeKey());
  return properties.getProperty(DASHBOARD_KEY_PROPERTY);
}

/** True only when the request's ?key= matches the stored key. No stored key means nobody gets in. */
function dashboardKeyMatches(params, properties) {
  const key = properties.getProperty(DASHBOARD_KEY_PROPERTY);
  return Boolean(key) && Boolean(params) && params.key === key;
}

/** Everything the page shows, from the Sheet. today is 'YYYY-MM-DD' in the Sheet's time zone. */
function dashboardData(spreadsheet, today) {
  const leads = loadLeads(spreadsheet).filter(lead => lead.contractor_id);
  const runs = loadRunLog(spreadsheet).filter(run => run.ran_at);
  const emailed = leads.filter(lead => lead.emailed_at);
  const day = text => String(text || '').slice(0, 10);

  const firstDay = addDays(today, 1 - DASHBOARD_DAYS);
  const sentByDay = [];
  for (let d = firstDay; d <= today; d = addDays(d, 1)) {
    sentByDay.push({day: d, count: emailed.filter(lead => day(lead.emailed_at) === d).length});
  }

  const windowStart = addDays(today, 1 - CREDIT_WINDOW_DAYS);
  const withBalance = runs.filter(run => run.credits_remaining !== '');
  const lastBalance = withBalance[withBalance.length - 1];
  const bounced = emailed.filter(lead => lead.email_success === 'no').length;

  return {
    today,
    outreachOn: outreachEnabled(spreadsheet),
    spreadsheetUrl: spreadsheet.getUrl(),
    leads: {
      total: leads.length,
      emailed: emailed.length,
      // Same rule as pendingLeads() in send.js: has an email, not sent, domain not known dead.
      pending: leads.filter(lead => lead.email && !lead.emailed_at && lead.email_success !== 'no').length,
      undeliverable: leads.filter(lead => !lead.emailed_at && lead.email_success === 'no').length,
      bounced,
      delivered: emailed.filter(lead => lead.email_success === 'yes').length,
      bounceRate: emailed.length ? bounced / emailed.length : null,
    },
    sentByDay,
    sentInWindow: sentByDay.reduce((sum, d) => sum + d.count, 0),
    credits: {
      remaining: lastBalance ? lastBalance.credits_remaining : null,
      asOf: lastBalance ? lastBalance.ran_at : null,
      usedLast30: runs.filter(run => day(run.ran_at) >= windowStart)
        .reduce((sum, run) => sum + (Number(run.credits_used) || 0), 0),
    },
    lastRun: runs[runs.length - 1] || null,
    recentRuns: runs.slice(-DASHBOARD_ROWS).reverse(),
    recentLeads: emailed.slice().sort((a, b) => b.emailed_at.localeCompare(a.emailed_at)).slice(0, DASHBOARD_ROWS)
      .map(lead => ({name: lead.name, emailed_at: lead.emailed_at, email_success: lead.email_success,
                     zip_code: lead.zip_code})),
  };
}

/** The dashboard page as an HTML string. Every value from the Sheet is escaped. */
function renderDashboard(data) {
  const e = escapeHtml_;
  const l = data.leads;
  const peak = Math.max(1, ...data.sentByDay.map(d => d.count));
  const statusText = s => (s === 'yes' ? 'delivered' : s === 'no' ? 'bounced' : 'not checked yet');

  const tile = (label, value, sub) =>
    `<div class="tile"><div class="label">${e(label)}</div><div class="value">${e(value)}</div>` +
    (sub ? `<div class="sub">${e(sub)}</div>` : '') + '</div>';

  const bars = data.sentByDay.map(d => {
    const weekday = new Date(`${d.day}T12:00:00Z`).toLocaleDateString('en-US', {weekday: 'short', timeZone: 'UTC'});
    return `<div class="bar-row"><span class="bar-day">${e(weekday)} ${e(d.day.slice(5))}</span>` +
      `<span class="bar-track"><span class="bar" style="width:${(100 * d.count / peak).toFixed(1)}%"></span></span>` +
      `<span class="bar-count">${d.count}</span></div>`;
  }).join('');

  const runRows = data.recentRuns.map(run => `<tr><td>${e(run.ran_at)}</td><td>${e(run.ingested)}</td>` +
    `<td class="num">${e(run.credits_used)}</td><td class="num">${e(run.credits_remaining)}</td>` +
    `<td class="num">${e(run.leads)}</td><td class="num">${e(run.emails_sent)}</td><td>${e(run.note)}</td></tr>`).join('');

  const leadRows = data.recentLeads.map(lead => `<tr><td>${e(lead.name)}</td><td>${e(lead.emailed_at)}</td>` +
    `<td><span class="pill ${e(lead.email_success || 'unchecked')}">${e(statusText(lead.email_success))}</span></td>` +
    `<td>${e(lead.zip_code)}</td></tr>`).join('');

  const bounceRate = l.bounceRate === null ? '' : `${Math.round(100 * l.bounceRate)}% of sent`;
  const credits = data.credits.remaining === null ? 'unknown' : data.credits.remaining;
  const lastRun = data.lastRun
    ? `Last run ${data.lastRun.ran_at}: ${data.lastRun.emails_sent} sent, ${data.lastRun.leads} new leads` +
      (data.lastRun.note ? ` (${data.lastRun.note})` : '')
    : 'No runs logged yet.';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>JoJoSpring outreach</title>
<style>${DASHBOARD_CSS}</style></head>
<body><main>
<header>
  <h1>JoJoSpring outreach</h1>
  <a class="sheet-link" href="${e(data.spreadsheetUrl)}" target="_blank" rel="noopener">Open the Sheet</a>
</header>
<div class="switch ${data.outreachOn ? 'on' : 'off'}">
  <strong>Automatic outreach is ${data.outreachOn ? 'ON' : 'OFF'}.</strong>
  ${data.outreachOn ? 'Weekday runs find leads and send emails.'
                    : 'Runs do nothing until the kill_switch tab says "yes".'}
</div>
<p class="muted">${e(lastRun)}</p>
<section class="tiles">
  ${tile('Leads found', l.total, `${l.pending} waiting to send`)}
  ${tile('Emails sent', l.emailed, `${data.sentInWindow} in the last ${DASHBOARD_DAYS} days`)}
  ${tile('Bounced', l.bounced, bounceRate)}
  ${tile('Shovels credits left', credits, data.credits.asOf ? `as of ${data.credits.asOf}` : '')}
  ${tile(`Credits used, ${CREDIT_WINDOW_DAYS} days`, data.credits.usedLast30, 'from run_log')}
</section>
<section>
  <h2>Emails sent per day</h2>
  <div class="bars">${bars}</div>
</section>
<section>
  <h2>Recently emailed</h2>
  ${leadRows ? `<div class="scroll"><table><thead><tr><th>Company</th><th>Emailed</th><th>Status</th><th>Zip</th>` +
    `</tr></thead><tbody>${leadRows}</tbody></table></div>` : '<p class="muted">No emails sent yet.</p>'}
</section>
<section>
  <h2>Recent runs</h2>
  ${runRows ? `<div class="scroll"><table><thead><tr><th>Ran at</th><th>Ingested</th><th class="num">Credits</th>` +
    `<th class="num">Left</th><th class="num">Leads</th><th class="num">Sent</th><th>Note</th></tr></thead>` +
    `<tbody>${runRows}</tbody></table></div>` : '<p class="muted">No runs logged yet.</p>'}
</section>
<p class="muted small">Replies aren't tracked yet; check the inbox. As of ${e(data.today)}. Read-only: edit the template,
blocklist and kill switch in the Sheet.</p>
</main></body></html>`;
}

function escapeHtml_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const DASHBOARD_CSS = `
:root { --bg:#f7f7f5; --card:#fff; --text:#1f2328; --muted:#636c76; --line:#e3e3df; --accent:#b7791f;
        --on-bg:#e8f5e9; --on-text:#1b5e20; --off-bg:#fdecea; --off-text:#8a1c12; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#16181b; --card:#1f2226; --text:#e6e6e3; --muted:#9aa1a9; --line:#30343a; --accent:#e0a84a;
          --on-bg:#173a1d; --on-text:#a5d6a7; --off-bg:#3d1c19; --off-text:#f4a79d; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text);
       font:15px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
header { display:flex; align-items:baseline; justify-content:space-between; gap:12px; flex-wrap:wrap; }
h1 { font-size: 24px; margin: 0 0 12px; }
h2 { font-size: 16px; margin: 28px 0 10px; }
a { color: var(--accent); }
.muted { color: var(--muted); }
.small { font-size: 13px; margin-top: 32px; }
.switch { padding: 12px 14px; border-radius: 8px; }
.switch.on { background: var(--on-bg); color: var(--on-text); }
.switch.off { background: var(--off-bg); color: var(--off-text); }
.tiles { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 16px; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
.label { color:var(--muted); font-size:13px; }
.value { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sub { color:var(--muted); font-size:13px; }
.bars { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
.bar-row { display:flex; align-items:center; gap:10px; font-size:13px; }
.bar-day { width: 84px; color: var(--muted); font-variant-numeric: tabular-nums; }
.bar-track { flex: 1; height: 14px; }
.bar { display:block; height:100%; background:var(--accent); border-radius:3px; min-width:0; }
.bar-count { width: 28px; text-align: right; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; background:var(--card); border:1px solid var(--line); border-radius:8px; }
table { width:100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align:left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
tr:last-child td { border-bottom: none; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.pill { padding: 1px 8px; border-radius: 10px; font-size: 12px; white-space: nowrap; }
.pill.yes { background: var(--on-bg); color: var(--on-text); }
.pill.no { background: var(--off-bg); color: var(--off-text); }
.pill.unchecked { color: var(--muted); border: 1px solid var(--line); }
`;
