import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { q, one } from '../db/index.js';
import { decrypt } from './crypto.js';
import { classifyIncoming, extractBouncedAddress, stripQuoted } from './classify.js';
import { raiseIssue } from './issues.js';
import { fetchNewGmail, friendlyGmailError } from './gmail.js';

export async function syncAllMailboxes() {
  const mailboxes = await q(`SELECT * FROM mailboxes WHERE status = 'active' ORDER BY id`);
  for (const mb of mailboxes) {
    try {
      if (mb.auth_type === 'gmail') await syncGmailMailbox(mb);
      else await syncMailbox(mb);
    } catch (err) {
      console.error(`[imap] ${mb.email}: ${err.message}`);
      const fails = await bumpImapFail(mb);
      if (fails >= 4) {
        await raiseIssue({
          severity: 'warning',
          title: `Cannot read replies from ${mb.email}`,
          detail: `${err.message}\n\nSending still works, but replies to this mailbox are not showing in the inbox. Check the IMAP host, port and password on the Mailboxes screen.`,
          refType: 'mailbox',
          refId: mb.id,
        });
      }
    }
  }
}

async function bumpImapFail(mb) {
  const row = await one(
    `UPDATE mailboxes SET consecutive_fails = consecutive_fails + 1
      WHERE id = $1 RETURNING consecutive_fails`,
    [mb.id],
  );
  return row ? row.consecutive_fails : 0;
}

// Gmail's API replaces IMAP entirely for a connected Google account.
async function syncGmailMailbox(mb) {
  const since = mb.last_imap_sync_at
    ? Math.floor(new Date(mb.last_imap_sync_at).getTime() / 1000) - 120
    : Math.floor(Date.now() / 1000) - 3600;

  let messages;
  try {
    messages = await fetchNewGmail(mb, since);
  } catch (err) {
    throw new Error(friendlyGmailError(err));
  }

  for (const msg of messages) {
    try {
      await storeIncoming(mb, msg);
    } catch (err) {
      console.error(`[gmail] ${mb.email}: ${err.message}`);
    }
  }

  await q(
    `UPDATE mailboxes SET last_imap_sync_at = NOW(), consecutive_fails = 0 WHERE id = $1`,
    [mb.id],
  );
}

async function syncMailbox(mb) {
  const client = new ImapFlow({
    host: mb.imap_host,
    port: mb.imap_port,
    secure: !!mb.imap_secure,
    auth: { user: mb.username || mb.email, pass: decrypt(mb.password_enc) },
    logger: false,
    socketTimeout: 60000,
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
    const state = (await one('SELECT * FROM imap_state WHERE mailbox_id = $1', [mb.id])) || {
      uid_validity: null,
      last_uid: 0,
    };

    const uidValidity = String(client.mailbox.uidValidity);
    let lastUid = Number(state.last_uid || 0);

    // The mailbox was recreated on the server — UIDs restarted, so trust nothing.
    if (state.uid_validity && String(state.uid_validity) !== uidValidity) lastUid = 0;

    // First ever sync: start from now instead of importing years of old mail.
    if (!lastUid) {
      const next = Number(client.mailbox.uidNext || 1);
      await saveState(mb.id, uidValidity, Math.max(0, next - 1));
      return;
    }

    let highest = lastUid;
    for await (const msg of client.fetch(
      { uid: `${lastUid + 1}:*` },
      { uid: true, envelope: true, source: true },
    )) {
      if (msg.uid <= lastUid) continue;
      highest = Math.max(highest, msg.uid);
      try {
        await handleIncoming(mb, msg);
      } catch (err) {
        console.error(`[imap] parse failed for uid ${msg.uid}: ${err.message}`);
      }
    }

    await saveState(mb.id, uidValidity, highest);
    await q(
      `UPDATE mailboxes SET last_imap_sync_at = NOW(), consecutive_fails = 0 WHERE id = $1`,
      [mb.id],
    );
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

async function saveState(mailboxId, uidValidity, lastUid) {
  await q(
    `INSERT INTO imap_state (mailbox_id, uid_validity, last_uid)
     VALUES ($1,$2,$3)
     ON CONFLICT (mailbox_id) DO UPDATE SET uid_validity = $2, last_uid = $3`,
    [mailboxId, uidValidity, lastUid],
  );
}

async function handleIncoming(mb, msg) {
  const parsed = await simpleParser(msg.source);
  return storeIncoming(mb, {
    from: parsed.from?.value?.[0]?.address?.toLowerCase() || '',
    subject: parsed.subject || '',
    body: parsed.text || stripHtml(parsed.html) || '',
    messageId: parsed.messageId || null,
    inReplyTo: parsed.inReplyTo || null,
    references: Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references ? [parsed.references] : [],
    date: parsed.date || new Date(),
    headers: parsed.headers,
  });
}

// Shared by both paths: classify, match to a lead, store, act.
async function storeIncoming(mb, incoming) {
  const { from, subject, body, messageId, inReplyTo, references } = incoming;

  // Already stored (a resync, or the same mail in two folders)
  if (messageId) {
    const dup = await one('SELECT 1 FROM messages WHERE message_id = $1 LIMIT 1', [messageId]);
    if (dup) return;
  }

  const verdict = classifyIncoming({ from, subject, body, headers: incoming.headers });
  const lead = await matchLead({ mb, from, inReplyTo, references, body, verdict });

  await q(
    `INSERT INTO messages
       (lead_id, campaign_id, mailbox_id, direction, from_addr, to_addr, subject,
        body, message_id, in_reply_to, kind, is_read, sent_at)
     VALUES ($1,$2,$3,'in',$4,$5,$6,$7,$8,$9,$10,FALSE,$11)`,
    [
      lead?.id || null,
      lead?.campaign_id || null,
      mb.id,
      from,
      mb.email,
      subject,
      body.slice(0, 20000),
      messageId,
      inReplyTo,
      verdict.kind,
      incoming.date || new Date(),
    ],
  );

  if (!lead) return;

  if (verdict.kind === 'bounce') {
    await q(
      `UPDATE leads SET status='bounced', next_send_at=NULL, last_error=$2 WHERE id=$1`,
      [lead.id, String(verdict.reason || '').slice(0, 300)],
    );
    if (verdict.hard) {
      await q(
        `INSERT INTO blocklist (value, reason) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [lead.email.toLowerCase(), 'Hard bounce'],
      );
    }
    await checkBounceRate(lead.campaign_id);
    return;
  }

  if (verdict.kind === 'auto_reply') {
    // Not a real reply. Hold the sequence for a week instead of killing it.
    await q(
      `UPDATE leads SET next_send_at = GREATEST(COALESCE(next_send_at, NOW()), NOW() + interval '7 days')
        WHERE id = $1 AND status IN ('pending','active')`,
      [lead.id],
    );
    return;
  }

  if (verdict.kind === 'unsubscribe') {
    await q(
      `UPDATE leads SET status='unsubscribed', next_send_at=NULL, replied_at=NOW() WHERE id=$1`,
      [lead.id],
    );
    await q(
      `INSERT INTO blocklist (value, reason) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [lead.email.toLowerCase(), 'Asked to stop'],
    );
    return;
  }

  // A human replied — every remaining follow-up stops right here.
  await q(
    `UPDATE leads SET status='replied', next_send_at=NULL, replied_at=NOW() WHERE id=$1`,
    [lead.id],
  );
}

async function matchLead({ mb, from, inReplyTo, references, body, verdict }) {
  // 1. Threading headers — the reliable way.
  const ids = [inReplyTo, ...references].filter(Boolean);
  if (ids.length) {
    const row = await one(
      `SELECT l.* FROM messages m JOIN leads l ON l.id = m.lead_id
        WHERE m.message_id = ANY($1) AND m.direction = 'out'
        ORDER BY m.sent_at DESC LIMIT 1`,
      [ids],
    );
    if (row) return row;
  }

  // 2. A bounce report names the dead address inside its body.
  if (verdict.kind === 'bounce') {
    const bounced = extractBouncedAddress(body);
    if (bounced) {
      const row = await one(
        `SELECT * FROM leads WHERE lower(email) = $1 ORDER BY id DESC LIMIT 1`,
        [bounced],
      );
      if (row) return row;
    }
  }

  // 3. Fall back to the sender address — they replied from the same inbox.
  if (from) {
    const row = await one(
      `SELECT l.* FROM leads l
        WHERE lower(l.email) = $1 AND l.mailbox_id = $2
        ORDER BY l.id DESC LIMIT 1`,
      [from, mb.id],
    );
    if (row) return row;

    const any = await one(
      `SELECT * FROM leads WHERE lower(email) = $1 ORDER BY id DESC LIMIT 1`,
      [from],
    );
    if (any) return any;
  }

  return null;
}

async function checkBounceRate(campaignId) {
  const campaign = await one('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
  if (!campaign || campaign.status !== 'active') return;

  const row = await one(
    `SELECT COUNT(*) FILTER (WHERE status='bounced')::int AS bounced,
            COUNT(*) FILTER (WHERE status <> 'pending')::int AS touched
       FROM leads WHERE campaign_id = $1`,
    [campaignId],
  );
  if (!row || row.touched < 40) return;

  const rate = (row.bounced / row.touched) * 100;
  if (rate >= Number(campaign.bounce_guard)) {
    await q(`UPDATE campaigns SET status='paused', paused_reason=$2 WHERE id=$1`, [
      campaignId,
      `Bounce rate reached ${rate.toFixed(1)}%`,
    ]);
    await raiseIssue({
      severity: 'critical',
      title: `Campaign paused: ${campaign.name}`,
      detail: `${row.bounced} of ${row.touched} addresses bounced (${rate.toFixed(1)}%). Sending stopped to protect your domains. Re-verify the list before restarting.`,
      refType: 'campaign',
      refId: campaignId,
    });
  }
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export { stripQuoted };
