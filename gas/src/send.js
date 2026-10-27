/**
 * Fill the hand-edited template for each lead not emailed yet and send it. The mailer is
 * passed in (main.js wraps GmailApp) so tests can use a fake, and onSent is called after
 * each send so the lead is marked right away, not at the end of the run.
 */

const STATE_NAMES = {
  AL: 'Alabama', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'Washington, D.C.', FL: 'Florida', GA: 'Georgia',
  ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska',
  NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// {slot} -> its text for a lead, with a fallback when the field is missing. Leads written
// by ingestion-only runs come from the Sheet and have no state, city or project type.
const TEMPLATE_SLOTS = {
  state: lead => STATE_NAMES[lead.state] || 'your area',  // the permit's state
  company: lead => lead.name || 'your company',
  city: lead => (lead.city ? titleCase_(lead.city) : 'your area'),  // the contractor's address
  project_type: lead => lead.project_type || 'electrical',
};

/** Throw if the template still has [placeholders] to fill in or names a slot that doesn't exist. */
function checkTemplate(template) {
  const text = `${template.subject}\n${template.body}`;
  const unfilled = text.match(/\[[^\]\n]+\]/g);
  if (unfilled) {
    throw new Error(`Fill in ${[...new Set(unfilled)].join(', ')} in the template tab before sending.`);
  }
  const unknown = (text.match(/\{[^}\n]*\}/g) || []).filter(slot => !(slot.slice(1, -1) in TEMPLATE_SLOTS));
  if (unknown.length) {
    throw new Error(`Unknown slot ${unknown.join(', ')} in the template tab. ` +
                    `Slots: ${Object.keys(TEMPLATE_SLOTS).map(s => `{${s}}`).join(', ')}.`);
  }
}

/** The template's subject and body with every {slot} filled for this lead. */
function fillTemplate(template, lead) {
  const fill = text => text.replace(/\{(\w+)\}/g, (match, slot) =>
    (slot in TEMPLATE_SLOTS ? TEMPLATE_SLOTS[slot](lead) : match));
  return {subject: fill(template.subject), body: fill(template.body)};
}

/**
 * Leads-tab rows still to email (blank emailed_at), each merged with the same lead from
 * this run's fetchLeads when there is one, so the template gets its state, city and
 * project type. Rows from earlier runs go out with the slot fallbacks.
 */
function pendingLeads(rows, freshLeads) {
  const fresh = {};
  (freshLeads || []).forEach(lead => { fresh[lead.contractor_id] = lead; });
  return rows.filter(row => row.contractor_id && row.email && !row.emailed_at)
    .map(row => Object.assign({}, fresh[row.contractor_id] || {}, row));
}

/**
 * Email each lead, up to maxEmails, skipping any the blocklist now catches (it may have
 * been edited since the lead was found). mailer(to, subject, body) sends and returns the
 * Gmail thread ID. Returns {sent: [{contractor_id, emailed_at, thread_id}], blocked: [ids]}.
 */
function sendEmails(leads, template, blocklist, mailer, options) {
  const {now, maxEmails, onSent} = options;
  checkTemplate(template);  // before any send, so a bad template sends nothing
  const sent = [];
  const blocked = [];
  for (const lead of leads) {
    if (lead.emailed_at) continue;
    if (sent.length >= maxEmails) break;
    if (blockedLead_(lead, blocklist)) {
      blocked.push(lead.contractor_id);
      continue;
    }
    const email = fillTemplate(template, lead);
    const record = {contractor_id: lead.contractor_id, emailed_at: now(),
                    thread_id: mailer(lead.email, email.subject, email.body)};
    if (onSent) onSent(record);
    sent.push(record);
  }
  return {sent, blocked};
}

function blockedLead_(lead, blocklist) {
  const domain = String(lead.email).split('@').pop().trim().toLowerCase();
  return blocklist.blocksCompany({business_name: lead.name}) || blocklist.emailDomains.has(domain);
}

/** "SAN LUIS OBISPO" -> "San Luis Obispo". Shovels addresses are often all caps. */
function titleCase_(text) {
  return String(text).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}
