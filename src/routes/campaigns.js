import express from 'express';
import { q, one } from '../db/index.js';
import { dailyCapacity, inWindow, nextWindowStart } from '../lib/scheduler.js';
import { render, withSignature, DEFAULT_OPT_OUT } from '../lib/render.js';

export const campaignRouter = express.Router();

const DEFAULT_SEQUENCE = [
  { step_no: 1, day_offset: 0, subject: '', body: '', same_thread: false },
  { step_no: 2, day_offset: 3, subject: '', body: '', same_thread: true },
  { step_no: 3, day_offset: 4, subject: '', body: '', same_thread: true },
  { step_no: 4, day_offset: 5, subject: '', body: '', same_thread: true },
];

async function stats(campaignId) {
  const row = await one(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status='pending')::int       AS pending,
       COUNT(*) FILTER (WHERE status='active')::int        AS in_sequence,
       COUNT(*) FILTER (WHERE status='replied')::int       AS replied,
       COUNT(*) FILTER (WHERE status='bounced')::int       AS bounced,
       COUNT(*) FILTER (WHERE status='unsubscribed')::int  AS unsubscribed,
       COUNT(*) FILTER (WHERE status='finished')::int      AS finished
     FROM leads WHERE campaign_id = $1`,
    [campaignId],
  );
  const sent = await one(
    `SELECT COUNT(*)::int AS c FROM messages WHERE campaign_id=$1 AND direction='out'`,
    [campaignId],
  );
  const touched = row.total - row.pending;
  return {
    ...row,
    sent: sent.c,
    reply_rate: touched ? +((row.replied / touched) * 100).toFixed(1) : 0,
    bounce_rate: touched ? +((row.bounced / touched) * 100).toFixed(1) : 0,
  };
}

campaignRouter.get('/', async (req, res) => {
  const rows = await q('SELECT * FROM campaigns ORDER BY id DESC');
  const out = [];
  for (const c of rows) {
    out.push({ ...c, stats: await stats(c.id), sending_now: c.status === 'active' && inWindow(c) });
  }
  res.json(out);
});

campaignRouter.get('/:id', async (req, res) => {
  const c = await one('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });

  const steps = await q(
    'SELECT * FROM sequence_steps WHERE campaign_id=$1 ORDER BY step_no', [c.id]);
  const mailboxes = await q(
    `SELECT m.id, m.email, m.sent_today, m.status FROM mailboxes m
       JOIN campaign_mailboxes cm ON cm.mailbox_id = m.id
      WHERE cm.campaign_id = $1 ORDER BY m.email`, [c.id]);

  res.json({
    ...c,
    steps,
    mailboxes,
    stats: await stats(c.id),
    capacity_per_day: dailyCapacity(c),
    sending_now: c.status === 'active' && inWindow(c),
    next_window: nextWindowStart(c),
  });
});

// Everything needed to judge how a campaign is doing, in one call.
campaignRouter.get('/:id/report', async (req, res) => {
  const c = await one('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  const id = c.id;

  const summary = await stats(id);

  const inbound = await one(
    `SELECT COUNT(*) FILTER (WHERE kind='normal')::int      AS replies,
            COUNT(*) FILTER (WHERE kind='auto_reply')::int  AS auto_replies,
            COUNT(*) FILTER (WHERE kind='bounce')::int      AS bounces,
            COUNT(*) FILTER (WHERE kind='unsubscribe')::int AS unsubscribes
       FROM messages WHERE campaign_id=$1 AND direction='in'`, [id]);

  const sentToday = await one(
    `SELECT COUNT(*)::int AS c FROM messages
      WHERE campaign_id=$1 AND direction='out' AND step_no IS NOT NULL
        AND (sent_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date`,
    [id, c.timezone]);

  // How far leads have got through the sequence, and what each step produced.
  const steps = await q(
    `SELECT s.step_no,
            s.subject,
            (SELECT COUNT(*)::int FROM messages m
              WHERE m.campaign_id=$1 AND m.direction='out' AND m.step_no=s.step_no) AS sent,
            (SELECT COUNT(*)::int FROM leads l
              WHERE l.campaign_id=$1 AND l.status='replied' AND l.current_step=s.step_no) AS replies_after
       FROM sequence_steps s WHERE s.campaign_id=$1 ORDER BY s.step_no`, [id]);

  const mailboxes = await q(
    `SELECT mb.id, mb.email,
            COUNT(m.*) FILTER (WHERE m.direction='out' AND m.step_no IS NOT NULL)::int AS sent,
            COUNT(m.*) FILTER (WHERE m.direction='in' AND m.kind='normal')::int AS replies,
            COUNT(m.*) FILTER (WHERE m.direction='in' AND m.kind='bounce')::int AS bounces,
            MAX(m.sent_at) FILTER (WHERE m.direction='out') AS last_sent
       FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE m.campaign_id=$1
      GROUP BY mb.id, mb.email ORDER BY sent DESC`, [id]);

  const daily = await q(
    `SELECT to_char((sent_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE direction='out' AND step_no IS NOT NULL)::int AS sent,
            COUNT(*) FILTER (WHERE direction='in' AND kind='normal')::int AS replies,
            COUNT(*) FILTER (WHERE direction='in' AND kind='bounce')::int AS bounces
       FROM messages
      WHERE campaign_id=$1 AND sent_at > NOW() - interval '30 days'
      GROUP BY 1 ORDER BY 1`, [id, c.timezone]);

  const replies = await q(
    `SELECT DISTINCT ON (l.id) l.id AS lead_id, l.email, l.first_name, l.company,
            m.subject, left(m.body, 220) AS snippet, m.sent_at, m.is_read
       FROM messages m JOIN leads l ON l.id = m.lead_id
      WHERE m.campaign_id=$1 AND m.direction='in' AND m.kind='normal'
      ORDER BY l.id, m.sent_at DESC`, [id]);
  replies.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));

  const problems = await q(
    `SELECT id AS lead_id, email, status, last_error FROM leads
      WHERE campaign_id=$1 AND status IN ('bounced','failed','unsubscribed')
      ORDER BY id DESC LIMIT 50`, [id]);

  const recent = await q(
    `SELECT m.lead_id, m.to_addr, m.step_no, m.subject, m.sent_at, mb.email AS mailbox_email
       FROM messages m LEFT JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE m.campaign_id=$1 AND m.direction='out'
      ORDER BY m.sent_at DESC LIMIT 10`, [id]);

  res.json({
    summary: { ...summary, sent_today: sentToday.c, ...inbound },
    steps, mailboxes, daily, replies, problems, recent,
  });
});

campaignRouter.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Give the campaign a name.' });

  const c = await one(
    `INSERT INTO campaigns (name, timezone, send_days, window_start, window_end,
                            daily_limit, gap_min_sec, gap_max_sec)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      b.name,
      b.timezone || 'Asia/Kolkata',
      b.send_days || [1, 2, 3, 4, 5],
      b.window_start || '10:00',
      b.window_end || '18:00',
      parseInt(b.daily_limit || 200, 10),
      parseInt(b.gap_min_sec || 45, 10),
      parseInt(b.gap_max_sec || 150, 10),
    ],
  );

  for (const s of DEFAULT_SEQUENCE) {
    await q(
      `INSERT INTO sequence_steps (campaign_id, step_no, day_offset, subject, body, same_thread)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [c.id, s.step_no, s.day_offset, s.subject, s.body, s.same_thread],
    );
  }

  const ids = b.mailbox_ids || [];
  for (const mid of ids) {
    await q(`INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES ($1,$2)
             ON CONFLICT DO NOTHING`, [c.id, mid]);
  }

  res.json(c);
});

campaignRouter.put('/:id', async (req, res) => {
  const b = req.body || {};
  const c = await one(
    `UPDATE campaigns SET
       name = COALESCE($2, name),
       timezone = COALESCE($3, timezone),
       send_days = COALESCE($4, send_days),
       window_start = COALESCE($5, window_start),
       window_end = COALESCE($6, window_end),
       daily_limit = COALESCE($7, daily_limit),
       gap_min_sec = COALESCE($8, gap_min_sec),
       gap_max_sec = COALESCE($9, gap_max_sec),
       bounce_guard = COALESCE($10, bounce_guard)
     WHERE id = $1 RETURNING *`,
    [
      req.params.id,
      b.name ?? null,
      b.timezone ?? null,
      b.send_days ?? null,
      b.window_start ?? null,
      b.window_end ?? null,
      b.daily_limit ? parseInt(b.daily_limit, 10) : null,
      b.gap_min_sec ? parseInt(b.gap_min_sec, 10) : null,
      b.gap_max_sec ? parseInt(b.gap_max_sec, 10) : null,
      b.bounce_guard ?? null,
    ],
  );
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });

  if (Array.isArray(b.mailbox_ids)) {
    await q('DELETE FROM campaign_mailboxes WHERE campaign_id = $1', [c.id]);
    for (const mid of b.mailbox_ids) {
      await q(`INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES ($1,$2)
               ON CONFLICT DO NOTHING`, [c.id, mid]);
    }
  }
  res.json(c);
});

// Start / pause. Starting runs the checks that stop an obviously broken launch.
campaignRouter.post('/:id/status', async (req, res) => {
  const status = req.body?.status;
  if (!['active', 'paused', 'draft'].includes(status)) {
    return res.status(400).json({ error: 'Status must be active, paused or draft.' });
  }

  if (status === 'active') {
    const problems = await preflight(req.params.id);
    if (problems.length) return res.status(400).json({ error: problems.join('\n') });
  }

  const c = await one(
    `UPDATE campaigns SET status=$2, paused_reason=NULL,
            next_dispatch_at = CASE WHEN $2='active' THEN NOW() ELSE next_dispatch_at END
      WHERE id=$1 RETURNING *`,
    [req.params.id, status],
  );
  res.json(c);
});

async function preflight(campaignId) {
  const problems = [];

  const mbCount = await one(
    `SELECT COUNT(*)::int AS c FROM campaign_mailboxes cm
       JOIN mailboxes m ON m.id = cm.mailbox_id
      WHERE cm.campaign_id = $1 AND m.status = 'active'`,
    [campaignId],
  );
  if (!mbCount.c) problems.push('No working mailbox is attached to this campaign.');

  const step1 = await one(
    `SELECT * FROM sequence_steps WHERE campaign_id=$1 AND step_no=1`, [campaignId]);
  if (!step1 || !step1.subject.trim() || !step1.body.trim()) {
    problems.push('The first mail has no subject or no body.');
  }

  const leads = await one(
    `SELECT COUNT(*)::int AS c FROM leads WHERE campaign_id=$1 AND status='pending'`,
    [campaignId]);
  if (!leads.c) problems.push('There are no leads waiting in this campaign.');

  return problems;
}

campaignRouter.put('/:id/steps', async (req, res) => {
  const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
  for (const s of steps) {
    await q(
      `INSERT INTO sequence_steps (campaign_id, step_no, day_offset, subject, body, same_thread)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (campaign_id, step_no) DO UPDATE
         SET day_offset=$3, subject=$4, body=$5, same_thread=$6`,
      [req.params.id, s.step_no, parseInt(s.day_offset || 0, 10),
        s.subject || '', s.body || '', s.same_thread !== false],
    );
  }
  const keep = steps.map((s) => s.step_no);
  if (keep.length) {
    await q(`DELETE FROM sequence_steps WHERE campaign_id=$1 AND step_no <> ALL($2)`,
      [req.params.id, keep]);
  }
  const out = await q('SELECT * FROM sequence_steps WHERE campaign_id=$1 ORDER BY step_no',
    [req.params.id]);
  res.json(out);
});

// Shows exactly what a real lead will receive, merge tags and all.
campaignRouter.post('/:id/preview', async (req, res) => {
  const lead = await one(
    `SELECT * FROM leads WHERE campaign_id=$1 ORDER BY id LIMIT 1`, [req.params.id]);
  const sample = lead || {
    email: 'sample@example.com', first_name: 'Ravi', last_name: 'Sharma',
    company: 'Example Studios', fields: {},
  };
  const mailbox = await one(
    `SELECT m.* FROM mailboxes m JOIN campaign_mailboxes cm ON cm.mailbox_id=m.id
      WHERE cm.campaign_id=$1 LIMIT 1`, [req.params.id]);

  const steps = await q('SELECT * FROM sequence_steps WHERE campaign_id=$1 ORDER BY step_no',
    [req.params.id]);

  res.json({
    lead_used: sample.email,
    previews: steps.map((s) => ({
      step_no: s.step_no,
      subject: s.step_no > 1 && s.same_thread
        ? `Re: ${render(steps[0].subject, sample)}`
        : render(s.subject, sample),
      body: withSignature(render(s.body, sample), mailbox || { signature: '' }, DEFAULT_OPT_OUT),
    })),
  });
});

campaignRouter.delete('/:id', async (req, res) => {
  await q('DELETE FROM campaigns WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});
