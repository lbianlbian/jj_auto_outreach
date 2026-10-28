// Dead-domain and bounce detection, with fake DNS responses and fake Gmail messages.
const test = require('node:test');
const {loadGas, assert} = require('./gas');
const {FakeSpreadsheetApp, FakeProperties} = require('./fakes');

const dns = body => () => ({status: 200, headers: {}, body: JSON.stringify(body)});

test('a domain has a mail server only with a real MX record', () => {
  const gas = loadGas();
  const urls = [];
  const fetch = (url, headers) => { urls.push(url); return dns({Status: 0, Answer: [{type: 15, data: '10 mx.shop.com.'}]})(); };
  assert.equal(gas.hasMailServer(fetch, 'shop.com'), true);
  assert.deepEqual(urls, ['https://dns.google/resolve?name=shop.com&type=MX']);

  assert.equal(gas.hasMailServer(dns({Status: 3}), 'nope.example'), false, 'no such domain');
  assert.equal(gas.hasMailServer(dns({Status: 0}), 'nomx.com'), false, 'no MX record');
  assert.equal(gas.hasMailServer(dns({Status: 0, Answer: [{type: 15, data: '0 .'}]}), 'null.com'), false, 'null MX');
  assert.equal(gas.hasMailServer(dns({Status: 0, Answer: [{type: 5, data: 'other.com.'}]}), 'cname.com'), false);
});

test('DNS trouble means "don\'t know", not "no mail server"', () => {
  const gas = loadGas();
  assert.equal(gas.hasMailServer(dns({Status: 2}), 'shop.com'), null, 'SERVFAIL');
  assert.equal(gas.hasMailServer(() => ({status: 500, headers: {}, body: ''}), 'shop.com'), null);
  assert.equal(gas.hasMailServer(() => ({status: 200, headers: {}, body: '<html>'}), 'shop.com'), null);
  assert.equal(gas.hasMailServer(() => { throw new Error('Address unavailable'); }, 'shop.com'), null);
});

test('a lead on a dead domain is not emailed, and its domain is looked up once', () => {
  const gas = loadGas();
  const ss = gas.setupSheets(new FakeSpreadsheetApp(), new FakeProperties()).spreadsheet;
  const outbox = [];
  const lookups = [];
  const undeliverable = [];
  const result = gas.sendEmails(
    [{contractor_id: 'C01', email: 'a@dead.com'}, {contractor_id: 'C02', email: 'b@DEAD.com'},
     {contractor_id: 'C03', email: 'c@live.com'}, {contractor_id: 'C04', email: 'd@flaky.com'}],
    {subject: 'Hi', body: 'Hello'}, gas.loadBlocklist(ss),
    to => { outbox.push(to); return `thread-${outbox.length}`; },
    {now: () => 'now', maxEmails: 20, onUndeliverable: id => undeliverable.push(id),
     mailServer: domain => { lookups.push(domain); return {'dead.com': false, 'live.com': true}[domain] ?? null; }});

  assert.deepEqual(outbox, ['c@live.com', 'd@flaky.com']);  // DNS couldn't say for flaky.com: send
  assert.deepEqual(result.undeliverable, ['C01', 'C02']);
  assert.deepEqual(undeliverable, ['C01', 'C02']);
  assert.deepEqual(lookups, ['dead.com', 'live.com', 'flaky.com']);
});

test('leads marked email_success "no" are never pending again', () => {
  const gas = loadGas();
  const rows = [{contractor_id: 'C01', email: 'a@1.com', emailed_at: '', email_success: 'no'},
                {contractor_id: 'C02', email: 'a@2.com', emailed_at: '', email_success: ''}];
  assert.deepEqual(gas.pendingLeads(rows, []).map(l => l.contractor_id), ['C02']);
});

const emailed = (id, extra = {}) => ({contractor_id: id, email: `${id.toLowerCase()}@shop.com`,
                                      emailed_at: '2026-10-27 09:00', thread_id: `t-${id}`, email_success: '', ...extra});

test('a bounce in the lead\'s thread marks it, the rest are marked delivered', () => {
  const gas = loadGas();
  const messages = [
    {threadId: 't-C01', from: 'JoJoSpring <me@gmail.com>', subject: 'Light fixtures', body: 'pitch'},  // our own email
    {threadId: 't-C01', from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
     subject: 'Delivery Status Notification (Failure)', body: 'Address not found'},
    {threadId: 't-C02', from: 'Bob <c02@shop.com>', subject: 'Re: Light fixtures', body: 'no thanks'},  // a reply
  ];
  const result = gas.findBounces([emailed('C01'), emailed('C02'), emailed('C03', {emailed_at: ''})], messages);
  assert.deepEqual(result, {bounced: ['C01'], delivered: ['C02']});  // C03 isn't emailed yet
});

test('a bounce in its own thread is matched by the failed address', () => {
  const gas = loadGas();
  const result = gas.findBounces([emailed('C01'), emailed('C02'), emailed('C03'), emailed('C04')], [
    {threadId: 'x1', from: 'postmaster@shop.com', subject: 'Undeliverable: Light fixtures', failedRecipients: 'c01@shop.com'},
    {threadId: 'x2', from: 'MAILER-DAEMON@mx.shop.com', subject: 'Returned mail', failedRecipients: null,
     body: 'The following address failed:\n\n    <C02@shop.com>: 550 user unknown'},
    {threadId: 'x3', from: 'mailer-daemon@x.net', subject: 'failure', body: 'xc03@shop.com and c04@shop.com.au failed'},
  ]);
  assert.deepEqual(result.bounced, ['C01', 'C02']);  // C03 and C04 only look similar
});

test('only changes are reported: "no" stays no, "yes" flips on a late bounce', () => {
  const gas = loadGas();
  const bounce = id => ({threadId: `t-${id}`, from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification'});
  const result = gas.findBounces([emailed('C01', {email_success: 'no'}), emailed('C02', {email_success: 'yes'}),
                                  emailed('C03', {email_success: 'yes'})], [bounce('C01'), bounce('C02')]);
  assert.deepEqual(result, {bounced: ['C02'], delivered: []});
});

test('through the Sheet: email_success is written by column name', () => {
  const gas = loadGas();
  const ss = gas.setupSheets(new FakeSpreadsheetApp(), new FakeProperties()).spreadsheet;
  gas.appendLeads(ss, [{contractor_id: 'C01', name: 'Shop', email: 'a@shop.com'}]);
  gas.updateLead(ss, 'C01', {email_success: 'no'});
  assert.equal(gas.loadLeads(ss)[0].email_success, 'no');
  assert.throws(() => gas.updateLead(ss, 'C99', {email_success: 'no'}), /No lead C99/);
});
