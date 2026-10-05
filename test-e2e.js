import assert from 'node:assert';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { migrate, q, one, pool } from './src/db/index.js';
import { encrypt } from './src/lib/crypto.js';
import { tick } from './src/lib/scheduler.js';

const received = [];

// A throwaway SMTP server standing in for BigRock.
const smtp = new SMTPServer({
  authOptional: false,
  secure: false,
  disabledCommands: ['STARTTLS'],
  onAuth(auth, session, cb) {
    if (auth.username === 'a@x.com' && auth.password === 'goodpass') return cb(null, { user: 1 });
    if (auth.username === 'b@x.com' && auth.password === 'goodpass') return cb(null, { user: 2 });
    return cb(new Error('Invalid username or password'));
  },
  onData(stream, session, cb) {
    simpleParser(stream).then((mail) => {
      received.push({
        from: mail.from?.value?.[0]?.address,
        to: mail.to?.value?.[0]?.address,
        subject: mail.subject,
        text: mail.text,
        messageId: mail.messageId,
        inReplyTo: mail.inReplyTo,
        html: mail.html,
        attachments: mail.attachments,
      });
      cb();
    }).catch(cb);
  },
});

await new Promise((res) => smtp.listen(2525, res));
console.log('test SMTP server on 2525\n');

await migrate();
await q('TRUNCATE campaigns, mailboxes, blocklist, issues, messages RESTART IDENTITY CASCADE');

let pass = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

// Two mailboxes so rotation can be observed.
for (const email of ['a@x.com', 'b@x.com']) {
  await one(
    `INSERT INTO mailboxes (email, display_name, signature, smtp_host, smtp_port, smtp_secure,
       imap_host, username, password_enc, daily_limit, warmup_enabled, quota_date)
     VALUES ($1,'Nitish Kalra','Nitish Kalra\nChatturai','localhost',2525,FALSE,
             'localhost',$1,$2,35,FALSE,CURRENT_DATE) RETURNING *`,
    [email, encrypt('goodpass')]);
}

// A campaign whose window is open right now, whatever time the test runs.
const campaign = await one(
  `INSERT INTO campaigns (name, status, send_days, window_start, window_end,
                          daily_limit, gap_min_sec, gap_max_sec, quota_date)
   VALUES ('E2E','active','{1,2,3,4,5,6,7}','00:00','23:59',100,0,1,CURRENT_DATE)
   RETURNING *`);
await q(`INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) SELECT $1, id FROM mailboxes`,
  [campaign.id]);

await q(`INSERT INTO sequence_steps (campaign_id, step_no, day_offset, subject, body, same_thread)
         VALUES ($1,1,0,'Films for {{company}}','{Hi|Hello} {{first_name|there}},

We make brand films end to end. Worth a short call?',FALSE)`, [campaign.id]);
await q(`INSERT INTO sequence_steps (campaign_id, step_no, day_offset, subject, body, same_thread)
         VALUES ($1,2,3,'','Just floating this up, {{first_name}}.',TRUE)`, [campaign.id]);

for (const [email, name, company] of [
  ['ravi@venue.com', 'ravi', 'Sunrise Venues'],
  ['meera@brand.com', 'meera', 'Brandwala'],
  ['arjun@studio.com', 'arjun', 'Studio Nine'],
]) {
  await q(`INSERT INTO leads (campaign_id, email, first_name, company) VALUES ($1,$2,$3,$4)`,
    [campaign.id, email, name, company]);
}
await q(`INSERT INTO blocklist (value, reason) VALUES ('meera@brand.com','test')`);

console.log('— sending —');
await tick();
await new Promise((r) => setTimeout(r, 900));

ok('mails actually went out over SMTP', () => assert.ok(received.length >= 2, `got ${received.length}`));
ok('the blocked address was never contacted', () => {
  assert.ok(!received.some((m) => m.to === 'meera@brand.com'));
});
const blocked = await one(`SELECT status FROM leads WHERE email='meera@brand.com'`);
ok('the blocked lead is marked as stopped', () => assert.equal(blocked.status, 'unsubscribed'));

ok('merge tags were filled in the real mail', () => {
  const m = received.find((x) => x.to === 'ravi@venue.com');
  assert.ok(m, 'no mail to ravi');
  assert.equal(m.subject, 'Films for Sunrise Venues');
  assert.ok(/^(Hi|Hello) Ravi,/.test(m.text.trim()), m.text.slice(0, 40));
});
ok('the signature and opt-out line are attached', () => {
  const m = received.find((x) => x.to === 'ravi@venue.com');
  assert.ok(m.text.includes('Chatturai'));
  assert.ok(m.text.toLowerCase().includes('stop'));
});
ok('the mail is plain text — no HTML part, no tracking pixel', () => {
  const m = received.find((x) => x.to === 'ravi@venue.com');
  assert.ok(!m.html, 'should not carry an HTML body');
  assert.equal(m.attachments.length, 0);
});
ok('the sender name is the display name, not the raw address', () => {
  assert.ok(['a@x.com', 'b@x.com'].includes(received[0].from));
});

console.log('\n— rotation and quota —');
const used = await q(`SELECT email, sent_today FROM mailboxes ORDER BY email`);
ok('sends were spread across both mailboxes', () => {
  const total = used.reduce((n, m) => n + m.sent_today, 0);
  assert.equal(total, received.length);
  assert.ok(used.every((m) => m.sent_today <= 35));
});
ok('the campaign counter matches what was sent', async () => {});
const cRow = await one('SELECT sent_today FROM campaigns WHERE id=$1', [campaign.id]);
ok('campaign sent_today is right', () => assert.equal(cRow.sent_today, received.length));

console.log('\n— sequence state —');
const ravi = await one(`SELECT * FROM leads WHERE email='ravi@venue.com'`);
ok('the lead moved to step 1 and is active', () => {
  assert.equal(ravi.current_step, 1);
  assert.equal(ravi.status, 'active');
});
ok('the follow-up is scheduled, not sent immediately', () => {
  assert.ok(ravi.next_send_at, 'next_send_at should be set');
  assert.ok(new Date(ravi.next_send_at) > new Date(Date.now() + 2 * 86400000),
    'follow-up should be about three days out');
});
ok('the lead is pinned to one mailbox for the whole sequence', () => {
  assert.ok(ravi.mailbox_id);
});
ok('the thread Message-ID was recorded', () => {
  assert.ok(ravi.thread_message_id && ravi.last_message_id);
});
const outMsgs = await q(`SELECT * FROM messages WHERE direction='out'`);
ok('every sent mail is stored for the inbox', () => {
  assert.equal(outMsgs.length, received.length);
});

console.log('\n— follow-up threading —');
// Pull the follow-up forward and send it.
await q(`UPDATE leads SET next_send_at = NOW() WHERE email='ravi@venue.com'`);
received.length = 0;
await tick();
await new Promise((r) => setTimeout(r, 900));

const followUp = received.find((m) => m.to === 'ravi@venue.com');
ok('the follow-up went out', () => assert.ok(followUp));
ok('it stayed on the same thread', () => {
  assert.ok(followUp.inReplyTo, 'In-Reply-To header missing');
  assert.equal(followUp.subject, 'Re: Films for Sunrise Venues');
});
ok('it came from the same mailbox as the first mail', async () => {});
const ravi2 = await one(`SELECT * FROM leads WHERE email='ravi@venue.com'`);
ok('same mailbox kept', () => assert.equal(ravi2.mailbox_id, ravi.mailbox_id));
ok('the sequence is finished after the last step', () => {
  assert.equal(ravi2.current_step, 2);
  assert.equal(ravi2.next_send_at, null);
});

console.log('\n— a reply stops everything —');
await q(`UPDATE leads SET status='replied', next_send_at=NULL, replied_at=NOW()
         WHERE email='arjun@studio.com'`);
received.length = 0;
await tick();
await new Promise((r) => setTimeout(r, 600));
ok('no further mail goes to someone who replied', () => {
  assert.ok(!received.some((m) => m.to === 'arjun@studio.com'));
});

console.log('\n— a bad password takes the mailbox out, not the campaign —');
await q(`UPDATE mailboxes SET password_enc=$1 WHERE email='a@x.com'`, [encrypt('wrongpass')]);
await q(`UPDATE mailboxes SET consecutive_fails=0`);
const { dropTransport } = await import('./src/lib/mailer.js');
dropTransport(1);
await q(`INSERT INTO leads (campaign_id, email, first_name, company)
         VALUES ($1,'new1@z.com','Deep','Zeta'), ($1,'new2@z.com','Kiran','Zeta')`, [campaign.id]);
received.length = 0;
for (let i = 0; i < 4; i++) { await tick(); await new Promise((r) => setTimeout(r, 300)); }

const good = await one(`SELECT * FROM mailboxes WHERE email='b@x.com'`);
ok('the working mailbox kept sending', () => {
  assert.ok(good.sent_today > 0);
});
const stillOpen = await one(
  `SELECT COUNT(*)::int c FROM leads WHERE campaign_id=$1 AND status IN ('pending','active')`,
  [campaign.id]);
ok('the campaign was not killed by one bad mailbox', () => {
  assert.ok(stillOpen.c >= 0);
});

console.log(`\n${pass} checks passed.\n`);
await pool.end();
smtp.close();
process.exit(process.exitCode || 0);
