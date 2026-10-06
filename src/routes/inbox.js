import express from 'express';
import { DateTime } from 'luxon';
import { q, one } from '../db/index.js';
import { sendMail, friendlySmtpError } from '../lib/mailer.js';
import { syncAllMailboxes } from '../lib/inbox.js';
import { openIssues } from '../lib/issues.js';
import { effectiveLimit, inWindow } from '../lib/scheduler.js';

export const inboxRouter = express.Router();

// Every reply, from every mailbox, in one list.
inboxRouter.get('/', async (req, res) => {
  const { kind = 'normal', unread, limit = 60 } = req.query;
  const where = [`m.direction = 'in'`, 'm.lead_id IS NOT NULL'];
  const params = [];

  if (kind && kind !== 'all') { params.push(kind); where.push(`m.kind = $${params.length}`); }
  if (unread === 'true') where.push('m.is_read = FALSE');

  params.push(Math.min(parseInt(limit, 10) || 60, 200));

  const rows = await q(
    `SELECT m.*, l.first_name, l.company, l.status AS lead_status, l.email AS lead_email,
            c.name AS campaign_name, mb.email AS mailbox_email
       FROM messages m
       LEFT JOIN leads l ON l.id = m.lead_id
       LEFT JOIN campaigns c ON c.id = m.campaign_id
       LEFT JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.sent_at DESC
      LIMIT $${params.length}`,
    params,
  );

  const counts = await one(
    `SELECT
       COUNT(*) FILTER (WHERE kind='normal' AND is_read=FALSE)::int AS unread_replies,
       COUNT(*) FILTER (WHERE kind='normal')::int       AS replies,
       COUNT(*) FILTER (WHERE kind='bounce')::int       AS bounces,
       COUNT(*) FILTER (WHERE kind='auto_reply')::int   AS auto_replies,
       COUNT(*) FILTER (WHERE kind='unsubscribe')::int  AS unsubscribes
     FROM messages WHERE direction='in' AND lead_id IS NOT NULL`,
  );

  res.json({ rows, counts });
});

// The whole back-and-forth with one lead.
inboxRouter.get('/thread/:leadId', async (req, res) => {
  const lead = await one(
    `SELECT l.*, c.name AS campaign_name, mb.email AS mailbox_email
       FROM leads l
       LEFT JOIN campaigns c ON c.id = l.campaign_id
       LEFT JOIN mailboxes mb ON mb.id = l.mailbox_id
      WHERE l.id = $1`, [req.params.leadId]);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });

  const messages = await q(
    'SELECT * FROM messages WHERE lead_id=$1 ORDER BY sent_at ASC', [lead.id]);

  await q(`UPDATE messages SET is_read=TRUE WHERE lead_id=$1 AND direction='in'`, [lead.id]);
  res.json({ lead, messages });
});

// Replying by hand goes out from the same mailbox, in the same thread.
inboxRouter.post('/thread/:leadId/reply', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Write something first.' });

  const lead = await one('SELECT * FROM leads WHERE id=$1', [req.params.leadId]);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });

  const mailbox = await one('SELECT * FROM mailboxes WHERE id=$1', [lead.mailbox_id]);
  if (!mailbox) {
    return res.status(400).json({ error: 'The mailbox this lead was contacted from no longer exists.' });
  }

  const lastIn = await one(
    `SELECT * FROM messages WHERE lead_id=$1 AND direction='in' ORDER BY sent_at DESC LIMIT 1`,
    [lead.id]);

  const subject = lead.thread_subject
    ? (lead.thread_subject.startsWith('Re: ') ? lead.thread_subject : `Re: ${lead.thread_subject}`)
    : 'Re:';

  try {
    const info = await sendMail({
      mailbox,
      to: lead.email,
      subject,
      text,
      inReplyTo: lastIn?.message_id || lead.last_message_id,
      references: [lead.thread_references, lastIn?.message_id].filter(Boolean).join(' '),
      threadId: lead.provider_thread_id || undefined,
    });

    await q(
      `INSERT INTO messages (lead_id, campaign_id, mailbox_id, direction, from_addr,
                             to_addr, subject, body, message_id, in_reply_to, is_read)
       VALUES ($1,$2,$3,'out',$4,$5,$6,$7,$8,$9,TRUE)`,
      [lead.id, lead.campaign_id, mailbox.id, mailbox.email, lead.email, subject, text,
        info.messageId, lastIn?.message_id || null],
    );
    await q('UPDATE leads SET last_message_id=$2 WHERE id=$1', [lead.id, info.messageId]);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: friendlySmtpError(err) });
  }
});

inboxRouter.post('/sync', async (req, res) => {
  syncAllMailboxes().catch((e) => console.error('[imap] manual sync:', e.message));
  res.json({ ok: true, message: 'Checking all mailboxes for new mail.' });
});

// ------------------------------------------------------------- dashboard ---
export const statsRouter = express.Router();

statsRouter.get('/', async (req, res) => {
  const today = DateTime.now().setZone('Asia/Kolkata').toISODate();

  const mailboxes = await q(`SELECT * FROM mailboxes ORDER BY email`);
  const campaigns = await q(`SELECT * FROM campaigns WHERE status='active'`);

  const sentToday = mailboxes.reduce(
    (n, m) => n + (String(m.quota_date) === today ? m.sent_today : 0), 0);
  const capacityToday = mailboxes
    .filter((m) => m.status === 'active')
    .reduce((n, m) => n + effectiveLimit(m), 0);

  const replies = await one(
    `SELECT COUNT(*) FILTER (WHERE kind='normal' AND is_read=FALSE)::int AS unread,
            COUNT(*) FILTER (WHERE kind='normal' AND sent_at::date = CURRENT_DATE)::int AS today
       FROM messages WHERE direction='in' AND lead_id IS NOT NULL`);

  const series = await q(
    `SELECT sent_at::date AS day,
            COUNT(*) FILTER (WHERE direction='out')::int AS sent,
            COUNT(*) FILTER (WHERE direction='in' AND kind='normal' AND lead_id IS NOT NULL)::int AS replies
       FROM messages
      WHERE sent_at > NOW() - interval '14 days'
      GROUP BY 1 ORDER BY 1`);

  res.json({
    sent_today: sentToday,
    capacity_today: capacityToday,
    mailboxes_active: mailboxes.filter((m) => m.status === 'active').length,
    mailboxes_total: mailboxes.length,
    campaigns_active: campaigns.length,
    campaigns_sending_now: campaigns.filter((c) => inWindow(c)).length,
    unread_replies: replies.unread,
    replies_today: replies.today,
    series,
    issues: await openIssues(),
  });
});

statsRouter.post('/issues/:id/resolve', async (req, res) => {
  await q('UPDATE issues SET resolved=TRUE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});
