/**
 * Catching addresses that can't take mail. Before sending, hasMailServer() asks DNS whether the
 * lead's domain has a mail server; after sending, findBounces() matches bounce messages in
 * Gmail to the leads they came back from. Both feed the leads tab's email_success column:
 * blank until checked, "no" for a dead domain or a bounce, "yes" for sent with no bounce seen.
 */

// Gmail search for bounce notices ({...} means OR). They usually land in the thread of the
// email that bounced, but some servers start a new thread, so search the whole mailbox.
const BOUNCE_QUERY = '{from:mailer-daemon from:postmaster subject:"delivery status notification" ' +
  'subject:undeliverable subject:"undelivered mail" subject:"mail delivery failed" ' +
  'subject:"delivery failure" subject:"returned mail"} newer_than:30d';

const BOUNCE_FROM = /mailer-daemon|postmaster/i;
const BOUNCE_SUBJECT = /delivery status notification|undeliverable|undelivered mail|mail delivery failed|delivery failure|returned mail/i;

/**
 * Whether the email domain has a mail server, from Google's DNS-over-HTTPS (free, no key).
 * Returns false for a domain that doesn't exist, has no MX record, or has a null MX
 * ("0 .", RFC 7505), and null when DNS can't say (network error, SERVFAIL), so a hiccup
 * doesn't drop a lead. fetch(url, headers) returns {status, body}, as in client.js.
 */
function hasMailServer(fetch, domain) {
  let data;
  try {
    const resp = fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, {});
    if (resp.status !== 200) return null;
    data = JSON.parse(resp.body);
  } catch (e) {
    return null;
  }
  if (data.Status === 3) return false;  // NXDOMAIN: no such domain
  if (data.Status !== 0) return null;
  const mx = (data.Answer || []).filter(answer => answer.type === 15);
  return mx.some(answer => !/^\d+\s+\.$/.test(String(answer.data).trim()));
}

/**
 * Match bounce messages to emailed leads. A message counts as a bounce when it's from a
 * mailer-daemon or postmaster or has a bounce subject; it hits a lead when it's in the lead's
 * thread, names the lead's address in X-Failed-Recipients, or mentions it in the body.
 * messages: [{threadId, from, subject, failedRecipients, body}]. Returns only the changes:
 * {bounced: ids not yet "no", delivered: ids still blank}.
 */
function findBounces(leads, messages) {
  const bounces = messages.filter(m => BOUNCE_FROM.test(m.from || '') || BOUNCE_SUBJECT.test(m.subject || ''));
  const bounceThreads = new Set(bounces.map(m => m.threadId));
  const text = bounces.map(m => `${m.failedRecipients || ''}\n${m.body || ''}`).join('\n').toLowerCase();
  const bounced = [];
  const delivered = [];
  leads.filter(lead => lead.contractor_id && lead.emailed_at).forEach(lead => {
    const email = String(lead.email || '').trim().toLowerCase();
    const hit = (lead.thread_id && bounceThreads.has(lead.thread_id)) || (email && mentions_(text, email));
    if (hit && lead.email_success !== 'no') bounced.push(lead.contractor_id);
    else if (!hit && !lead.email_success) delivered.push(lead.contractor_id);
  });
  return {bounced, delivered};
}

/** Whether text has this exact address, so bob@x.com doesn't match jimbob@x.com. */
function mentions_(text, email) {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w.+-])${escaped}($|[^\\w.-]|\\.(?!\\w))`).test(text);
}
