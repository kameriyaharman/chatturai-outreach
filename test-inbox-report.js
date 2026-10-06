// Checks that only replies to our own mails reach the inbox, and that the
// campaign report endpoint returns sane numbers. Needs DATABASE_URL.
import assert from 'node:assert';
import express from 'express';
import { migrate, q, one, pool } from './src/db/index.js';
import { encrypt } from './src/lib/crypto.js';
import { setGmailBackend } from './src/lib/gmail.js';
import { syncAllMailboxes, sameSender } from './src/lib/inbox.js';

assert.ok(sameSender('ravi@venue.com', 'ravi@venue.com'));
assert.ok(sameSender('boss@venue.com', 'ravi@venue.com'), 'a colleague at the same company counts');
assert.ok(!sameSender('someone@gmail.com', 'ravi@gmail.com'), 'gmail.com is not one company');
assert.ok(!sameSender('akash@chatturai.com', 'ravi@venue.com'));
import { campaignRouter } from './src/routes/campaigns.js';
import { inboxRouter } from './src/routes/inbox.js';

await migrate();
await q('TRUNCATE messages, leads, campaign_mailboxes, sequence_steps, campaigns, mailboxes, blocklist RESTART IDENTITY CASCADE');

// A stray, unrelated message stored by the old behaviour — migrate must clear it.
const mb = await one(`INSERT INTO mailboxes (email, display_name, username, auth_type, oauth_refresh_enc)
  VALUES ('vinita@chatturai.com','Vinita','vinita@chatturai.com','gmail',$1) RETURNING *`, [encrypt('rt')]);
await q(`INSERT INTO messages (mailbox_id, direction, from_addr, subject, body)
  VALUES ($1,'in','news@shop.com','Sale!','buy')`, [mb.id]);
await migrate();
assert.equal((await one(`SELECT COUNT(*)::int c FROM messages WHERE lead_id IS NULL`)).c, 0,
  'old unrelated inbox rows are cleaned up');

await q(`INSERT INTO mailboxes (email, display_name, username) VALUES ('akash@chatturai.com','Akash','a')`);
// an old self-copy stored as a reply before the fix — must be cleaned up
const c0 = await one(`INSERT INTO campaigns (name) VALUES ('old') RETURNING *`);
const l0 = await one(`INSERT INTO leads (campaign_id, email, status) VALUES ($1,'karthik@chatturai.com','replied') RETURNING *`, [c0.id]);
await q(`INSERT INTO messages (lead_id, campaign_id, direction, from_addr, subject, body, kind)
  VALUES ($1,$2,'in','akash@chatturai.com','Hi Eric','pitch','normal'),
         ($1,$2,'in','mailer-daemon@googlemail.com','Undeliverable','x','bounce'),
         ($1,$2,'in','karthik@chatturai.com','Re: hi','real','normal')`, [l0.id, c0.id]);
await migrate();
assert.deepEqual((await q(`SELECT from_addr FROM messages WHERE lead_id=$1 ORDER BY id`, [l0.id])).map((r) => r.from_addr),
  ['mailer-daemon@googlemail.com', 'karthik@chatturai.com'], 'self-copies removed, bounces and real replies kept');
await q('DELETE FROM campaigns WHERE id=$1', [c0.id]);

const c = await one(`INSERT INTO campaigns (name) VALUES ('Test camp') RETURNING *`);
await q(`INSERT INTO sequence_steps (campaign_id, step_no, day_offset, subject, body) VALUES ($1,1,0,'Hello','Hi'),($1,2,3,'','Bump')`, [c.id]);
const sent = await one(`INSERT INTO leads (campaign_id, email, first_name, status, current_step, mailbox_id)
  VALUES ($1,'ravi@venue.com','Ravi','active',1,$2) RETURNING *`, [c.id, mb.id]);
const notYet = await one(`INSERT INTO leads (campaign_id, email, status, mailbox_id)
  VALUES ($1,'later@venue.com','pending',$2) RETURNING *`, [c.id, mb.id]);
await q(`INSERT INTO messages (lead_id, campaign_id, mailbox_id, direction, step_no, from_addr, to_addr, subject, body, message_id)
  VALUES ($1,$2,$3,'out',1,'vinita@chatturai.com','ravi@venue.com','Hello','Hi','<out-1@x>')`, [sent.id, c.id, mb.id]);

const msg = (from, subject, extra = {}) => ({
  from, subject, body: 'text', messageId: `<${Math.random()}@m>`, inReplyTo: null,
  references: [], date: new Date(), headers: new Map(), ...extra,
});
setGmailBackend({
  fetch: async () => [
    msg('news@shop.com', 'Big sale'),                                  // unrelated
    msg('friend@gmail.com', 'Dinner?'),                                // unrelated
    msg('later@venue.com', 'Random hello'),                            // a lead we never mailed
    msg('ravi@venue.com', 'Re: Hello', { inReplyTo: '<out-1@x>' }),    // a real reply
    // a copy of our own mail landing in another of our mailboxes, threaded to the lead
    msg('akash@chatturai.com', 'Re: Hello', { inReplyTo: '<out-1@x>' }),
    // someone unrelated replying on the thread
    msg('random@other.com', 'Re: Hello', { inReplyTo: '<out-1@x>' }),
  ],
});
await syncAllMailboxes();

const inbound = await q(`SELECT from_addr FROM messages WHERE direction='in'`);
assert.deepEqual(inbound.map((r) => r.from_addr), ['ravi@venue.com'], 'only the real reply is stored');
assert.equal((await one('SELECT status FROM leads WHERE id=$1', [sent.id])).status, 'replied');
assert.equal((await one('SELECT status FROM leads WHERE id=$1', [notYet.id])).status, 'pending');

// Exercise the HTTP routes.
const app = express();
app.use(express.json());
app.use('/c', campaignRouter);
app.use('/i', inboxRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const r = await (await fetch(`${base}/c/${c.id}/report`)).json();
assert.equal(r.summary.total, 2);
assert.equal(r.summary.sent, 1);
assert.equal(r.summary.replied, 1);
assert.equal(r.steps[0].sent, 1);
assert.equal(r.steps[0].replies_after, 1);
assert.equal(r.mailboxes[0].replies, 1);
assert.equal(r.replies.length, 1);
assert.equal(r.recent.length, 1);

const inbox = await (await fetch(`${base}/i?kind=all`)).json();
assert.equal(inbox.rows.length, 1);

const del = await (await fetch(`${base}/c/${c.id}`, { method: 'DELETE' })).json();
assert.ok(del.ok);
assert.equal((await one('SELECT COUNT(*)::int c FROM leads')).c, 0, 'delete removes leads');
assert.equal((await one('SELECT COUNT(*)::int c FROM messages')).c, 0, 'delete removes history');

server.close();
await pool.end();
console.log('inbox filter + report + delete: all checks passed');
