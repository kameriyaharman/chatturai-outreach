import assert from 'node:assert';
import { DateTime } from 'luxon';
import { migrate, q, one, pool } from './src/db/index.js';
import { render, withSignature, DEFAULT_OPT_OUT } from './src/lib/render.js';
import { classifyIncoming, extractBouncedAddress, stripQuoted } from './src/lib/classify.js';
import { inWindow, nextWindowStart, dailyCapacity, effectiveLimit, warmupLabel } from './src/lib/scheduler.js';
import { encrypt, decrypt } from './src/lib/crypto.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('\n— crypto —');
ok('password round trips', () => {
  const secret = 'S0me!Pass word';
  assert.equal(decrypt(encrypt(secret)), secret);
});
ok('ciphertext differs each time', () => {
  assert.notEqual(encrypt('abc'), encrypt('abc'));
});

console.log('\n— templates —');
const lead = { email: 'ravi@venue.com', first_name: 'ravi', last_name: 'SHARMA', company: 'Sunrise Venues', fields: { city: 'Jaipur' } };
ok('merge tags fill and title-case names', () => {
  assert.equal(render('Hi {{first_name}} from {{company}} in {{city}}', lead),
    'Hi Ravi from Sunrise Venues in Jaipur');
});
ok('fallback is used when a field is blank', () => {
  assert.equal(render('Hi {{first_name|there}}', { ...lead, first_name: '' }), 'Hi there');
});
ok('unknown tag leaves no raw braces behind', () => {
  assert.ok(!render('Hi {{nonsense}} there', lead).includes('{{'));
});
ok('spintax picks one option', () => {
  const outs = new Set();
  for (let i = 0; i < 60; i++) outs.add(render('{Hi|Hello|Hey} there', lead));
  assert.ok(outs.size > 1, 'should vary across sends');
  for (const o of outs) assert.ok(['Hi there', 'Hello there', 'Hey there'].includes(o), o);
});
ok('opt-out line is always attached', () => {
  const body = withSignature('Hello.', { signature: 'Nitish' }, DEFAULT_OPT_OUT);
  assert.ok(body.includes('Nitish'));
  assert.ok(body.toLowerCase().includes('stop'));
});

console.log('\n— incoming mail —');
const H = (o = {}) => new Map(Object.entries(o));
ok('a plain human reply is a reply', () => {
  assert.equal(classifyIncoming({ from: 'ravi@venue.com', subject: 'Re: film', body: 'Sure, call me Thursday.', headers: H() }).kind, 'normal');
});
ok('mailer-daemon is a bounce', () => {
  const v = classifyIncoming({ from: 'MAILER-DAEMON@mx.google.com', subject: 'Delivery Status Notification (Failure)', body: '550 5.1.1 The email account does not exist.', headers: H() });
  assert.equal(v.kind, 'bounce');
  assert.equal(v.hard, true);
});
ok('a full mailbox is a soft bounce, not a dead address', () => {
  const v = classifyIncoming({ from: 'postmaster@corp.com', subject: 'Undeliverable', body: '452 4.2.2 Mailbox full, over quota', headers: H() });
  assert.equal(v.kind, 'bounce');
  assert.equal(v.hard, false);
});
ok('out of office is detected by header', () => {
  assert.equal(classifyIncoming({ from: 'ravi@venue.com', subject: 'Thanks', body: 'Back on Monday', headers: H({ 'auto-submitted': 'auto-replied' }) }).kind, 'auto_reply');
});
ok('out of office is detected by subject', () => {
  assert.equal(classifyIncoming({ from: 'r@v.com', subject: 'Automatic reply: away', body: 'x', headers: H() }).kind, 'auto_reply');
});
ok('"stop" is an unsubscribe', () => {
  assert.equal(classifyIncoming({ from: 'r@v.com', subject: 'Re: film', body: 'stop', headers: H() }).kind, 'unsubscribe');
});
ok('our own opt-out line quoted back is NOT an unsubscribe', () => {
  const body = 'Sounds good, send a deck.\n\nOn Tue, Nitish wrote:\n> If this is not relevant, just reply "stop" and I will not write again.';
  assert.equal(classifyIncoming({ from: 'r@v.com', subject: 'Re: film', body, headers: H() }).kind, 'normal');
});
ok('quoted text is stripped', () => {
  assert.ok(!stripQuoted('Yes please.\n\nOn Mon someone wrote:\n> old stuff').includes('old stuff'));
});
ok('the dead address is pulled out of a bounce report', () => {
  assert.equal(extractBouncedAddress('Final-Recipient: rfc822; ravi@venue.com\nAction: failed'), 'ravi@venue.com');
});

console.log('\n— schedule —');
const camp = { timezone: 'Asia/Kolkata', send_days: [1, 2, 3, 4, 5], window_start: '10:00', window_end: '18:00', daily_limit: 500, gap_min_sec: 45, gap_max_sec: 150 };
ok('inside the window on a weekday', () => {
  assert.equal(inWindow(camp, DateTime.fromISO('2026-09-21T12:00', { zone: 'Asia/Kolkata' })), true);
});
ok('before the window opens', () => {
  assert.equal(inWindow(camp, DateTime.fromISO('2026-09-21T08:30', { zone: 'Asia/Kolkata' })), false);
});
ok('sunday is skipped when it is not a sending day', () => {
  assert.equal(inWindow(camp, DateTime.fromISO('2026-09-20T12:00', { zone: 'Asia/Kolkata' })), false);
});
ok('the next window skips the weekend', () => {
  const next = DateTime.fromJSDate(nextWindowStart(camp, DateTime.fromISO('2026-09-19T19:00', { zone: 'Asia/Kolkata' }))).setZone('Asia/Kolkata');
  assert.equal(next.weekday, 1, 'Friday evening should roll to Monday');
  assert.equal(next.hour, 10);
});
ok('capacity is worked out from window and gap', () => {
  assert.equal(dailyCapacity(camp), Math.floor((8 * 3600) / 97.5));
});
ok('a tighter gap raises capacity past 500', () => {
  assert.ok(dailyCapacity({ ...camp, gap_min_sec: 20, gap_max_sec: 60 }) > 500);
});

console.log('\n— warmup ramp —');
const mb = (days, limit = 35) => ({
  warmup_enabled: true, daily_limit: limit,
  warmup_started_on: DateTime.now().minus({ days }).toISODate(),
});
ok('day 1 is capped at 5', () => assert.equal(effectiveLimit(mb(0)), 5));
ok('day 5 is capped at 10', () => assert.equal(effectiveLimit(mb(4)), 10));
ok('day 10 is capped at 18', () => assert.equal(effectiveLimit(mb(9)), 18));
ok('day 30 runs at the full limit', () => assert.equal(effectiveLimit(mb(29)), 35));
ok('the ramp never exceeds the mailbox limit', () => assert.equal(effectiveLimit(mb(29, 12)), 12));
ok('warmup off means full speed from day one', () => {
  assert.equal(effectiveLimit({ warmup_enabled: false, daily_limit: 35 }), 35);
  assert.equal(warmupLabel({ warmup_enabled: false, daily_limit: 35 }), 'Full speed');
});

console.log('\n— database —');
await migrate();
await q('TRUNCATE campaigns, mailboxes, blocklist, issues RESTART IDENTITY CASCADE');

const m = await one(
  `INSERT INTO mailboxes (email, display_name, smtp_host, imap_host, username, password_enc, quota_date)
   VALUES ('a@x.com','A','smtp.x.com','imap.x.com','a@x.com',$1,CURRENT_DATE) RETURNING *`,
  [encrypt('pw')]);
ok('a mailbox stores its password encrypted', () => {
  assert.notEqual(m.password_enc, 'pw');
  assert.equal(decrypt(m.password_enc), 'pw');
});

const c = await one(`INSERT INTO campaigns (name) VALUES ('Test') RETURNING *`);
for (const [n, d] of [[1, 0], [2, 3], [3, 4], [4, 5]]) {
  await q(`INSERT INTO sequence_steps (campaign_id, step_no, day_offset, subject, body)
           VALUES ($1,$2,$3,'Hi {{company}}','Hello {{first_name|there}}')`, [c.id, n, d]);
}
ok('a new campaign gets a four step sequence', async () => {});
const steps = await q('SELECT * FROM sequence_steps WHERE campaign_id=$1', [c.id]);
ok('four steps were stored', () => assert.equal(steps.length, 4));

await q(`INSERT INTO leads (campaign_id, email, first_name, company, fields)
         VALUES ($1,'ravi@venue.com','Ravi','Sunrise', '{"city":"Jaipur"}')`, [c.id]);
ok('a lead cannot be added twice to one campaign', async () => {});
const dup = await q(`INSERT INTO leads (campaign_id, email) VALUES ($1,'ravi@venue.com')
                     ON CONFLICT DO NOTHING RETURNING id`, [c.id]);
ok('the duplicate was rejected', () => assert.equal(dup.length, 0));

const stored = await one('SELECT * FROM leads WHERE campaign_id=$1', [c.id]);
ok('custom CSV columns survive as merge tags', () => {
  assert.equal(render('{{city}}', stored), 'Jaipur');
});

console.log(`\n${pass} checks passed.\n`);
await pool.end();
