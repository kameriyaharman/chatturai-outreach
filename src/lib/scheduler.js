import { DateTime } from 'luxon';
import { q, one } from '../db/index.js';
import { sendMail, friendlySmtpError, isHardBounce, dropTransport } from './mailer.js';
import { render, withSignature, DEFAULT_OPT_OUT } from './render.js';
import { config } from '../config.js';
import { raiseIssue } from './issues.js';

// ---------------------------------------------------------------- warmup ---
// A brand new mailbox that sends 35 mails on day one gets blacklisted.
// This ramp is applied automatically until the mailbox is old enough.
const RAMP = [
  { untilDay: 3, cap: 5 },
  { untilDay: 7, cap: 10 },
  { untilDay: 14, cap: 18 },
  { untilDay: 21, cap: 28 },
];

export function effectiveLimit(mailbox, today = DateTime.now()) {
  if (!mailbox.warmup_enabled || !mailbox.warmup_started_on) return mailbox.daily_limit;
  const start = DateTime.fromJSDate(new Date(mailbox.warmup_started_on));
  const day = Math.floor(today.diff(start, 'days').days) + 1;
  for (const stage of RAMP) {
    if (day <= stage.untilDay) return Math.min(mailbox.daily_limit, stage.cap);
  }
  return mailbox.daily_limit;
}

export function warmupLabel(mailbox) {
  if (!mailbox.warmup_enabled || !mailbox.warmup_started_on) return 'Full speed';
  const day = Math.floor(DateTime.now().diff(DateTime.fromJSDate(new Date(mailbox.warmup_started_on)), 'days').days) + 1;
  if (day > 21) return 'Full speed';
  return `Warming up — day ${day}`;
}

// ---------------------------------------------------------------- window ---
export function inWindow(campaign, now = DateTime.now()) {
  const local = now.setZone(campaign.timezone);
  const days = campaign.send_days || [];
  if (!days.includes(local.weekday)) return false;

  const [sh, sm] = String(campaign.window_start).split(':').map(Number);
  const [eh, em] = String(campaign.window_end).split(':').map(Number);
  const mins = local.hour * 60 + local.minute;
  return mins >= sh * 60 + sm && mins < eh * 60 + em;
}

export function nextWindowStart(campaign, now = DateTime.now()) {
  const days = campaign.send_days && campaign.send_days.length ? campaign.send_days : [1, 2, 3, 4, 5];
  const [sh, sm] = String(campaign.window_start).split(':').map(Number);
  let cursor = now.setZone(campaign.timezone);

  for (let i = 0; i <= 14; i++) {
    const day = cursor.plus({ days: i });
    if (!days.includes(day.weekday)) continue;
    const start = day.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
    if (start > now.setZone(campaign.timezone)) return start.toUTC().toJSDate();
  }
  return now.plus({ days: 1 }).toJSDate();
}

// How many mails these settings can physically deliver in a day.
export function dailyCapacity(campaign) {
  const [sh, sm] = String(campaign.window_start).split(':').map(Number);
  const [eh, em] = String(campaign.window_end).split(':').map(Number);
  const windowSec = (eh * 60 + em - sh * 60 - sm) * 60;
  const avgGap = (campaign.gap_min_sec + campaign.gap_max_sec) / 2;
  if (avgGap <= 0) return campaign.daily_limit;
  return Math.max(0, Math.floor(windowSec / avgGap));
}

// ------------------------------------------------------------ quota reset --
async function resetDailyCounters() {
  const today = DateTime.now().toISODate();
  await q(
    `UPDATE mailboxes SET sent_today = 0, quota_date = $1
      WHERE quota_date IS DISTINCT FROM $1`,
    [today],
  );
  await q(
    `UPDATE campaigns SET sent_today = 0, quota_date = $1
      WHERE quota_date IS DISTINCT FROM $1`,
    [today],
  );
}

// ------------------------------------------------------------- mailbox pick -
async function pickMailbox(campaignId) {
  const rows = await q(
    `SELECT m.* FROM mailboxes m
       JOIN campaign_mailboxes cm ON cm.mailbox_id = m.id
      WHERE cm.campaign_id = $1 AND m.status = 'active'
      ORDER BY m.sent_today ASC, m.last_used_at ASC NULLS FIRST`,
    [campaignId],
  );
  const now = DateTime.now();
  return rows.find((m) => m.sent_today < effectiveLimit(m, now)) || null;
}

async function mailboxById(id) {
  return one('SELECT * FROM mailboxes WHERE id = $1', [id]);
}

// --------------------------------------------------------------- blocklist --
async function isBlocked(email) {
  const domain = '@' + String(email).split('@')[1];
  const row = await one(
    'SELECT 1 FROM blocklist WHERE value = $1 OR value = $2 LIMIT 1',
    [String(email).toLowerCase(), domain.toLowerCase()],
  );
  return !!row;
}

// ------------------------------------------------------------------ sending -
async function sendToLead(campaign, lead, step) {
  let mailbox = lead.mailbox_id ? await mailboxById(lead.mailbox_id) : null;

  // A lead keeps the same mailbox for its whole sequence, otherwise the
  // thread breaks and the recipient sees four different senders.
  if (mailbox && (mailbox.status !== 'active' || mailbox.sent_today >= effectiveLimit(mailbox))) {
    return { result: 'defer_lead' };
  }
  if (!mailbox) {
    mailbox = await pickMailbox(campaign.id);
    if (!mailbox) return { result: 'no_mailbox' };
  }

  const vars = { ...lead, fields: lead.fields || {} };
  const isFirst = step.step_no === 1 || !lead.thread_message_id;

  let subject;
  if (!isFirst && step.same_thread && lead.thread_subject) {
    subject = lead.thread_subject.startsWith('Re: ') ? lead.thread_subject : `Re: ${lead.thread_subject}`;
  } else {
    subject = render(step.subject, vars);
  }

  const body = withSignature(render(step.body, vars), mailbox, DEFAULT_OPT_OUT);

  const threadHeaders = !isFirst && step.same_thread
    ? {
      inReplyTo: lead.last_message_id,
      references: lead.thread_references || lead.thread_message_id,
      threadId: lead.provider_thread_id || undefined,
    }
    : {};

  try {
    const info = await sendMail({ mailbox, to: lead.email, subject, text: body, ...threadHeaders });

    const references = [lead.thread_references, info.messageId].filter(Boolean).join(' ').trim();

    await q(
      `UPDATE leads SET
         status = 'active',
         current_step = $2,
         mailbox_id = $3,
         thread_subject = COALESCE(thread_subject, $4),
         thread_message_id = COALESCE(thread_message_id, $5),
         last_message_id = $5,
         thread_references = $6,
         provider_thread_id = COALESCE(provider_thread_id, $8),
         next_send_at = $7,
         last_error = NULL
       WHERE id = $1`,
      [lead.id, step.step_no, mailbox.id, subject, info.messageId, references,
        await computeNextSend(campaign, step.step_no), info.threadId || null],
    );

    await q(
      `INSERT INTO messages
         (lead_id, campaign_id, mailbox_id, direction, step_no, from_addr, to_addr,
          subject, body, message_id, in_reply_to, is_read)
       VALUES ($1,$2,$3,'out',$4,$5,$6,$7,$8,$9,$10,TRUE)`,
      [lead.id, campaign.id, mailbox.id, step.step_no, mailbox.email, lead.email,
        subject, body, info.messageId, threadHeaders.inReplyTo || null],
    );

    await q(
      `UPDATE mailboxes SET sent_today = sent_today + 1, last_used_at = NOW(),
                            consecutive_fails = 0, last_error = NULL
        WHERE id = $1`,
      [mailbox.id],
    );
    await q('UPDATE campaigns SET sent_today = sent_today + 1 WHERE id = $1', [campaign.id]);

    return { result: 'sent' };
  } catch (err) {
    const friendly = friendlySmtpError(err);

    if (isHardBounce(err)) {
      await q(
        `UPDATE leads SET status='bounced', next_send_at=NULL, last_error=$2 WHERE id=$1`,
        [lead.id, friendly],
      );
      await checkBounceGuard(campaign);
      return { result: 'bounced' };
    }

    // Not the lead's fault — the mailbox is unhappy.
    const fails = mailbox.consecutive_fails + 1;
    await q('UPDATE mailboxes SET consecutive_fails = $2, last_error = $3 WHERE id = $1',
      [mailbox.id, fails, friendly]);

    if (fails >= 5) {
      await q(`UPDATE mailboxes SET status='error' WHERE id=$1`, [mailbox.id]);
      dropTransport(mailbox.id);
      await raiseIssue({
        severity: 'critical',
        title: `Mailbox paused: ${mailbox.email}`,
        detail: `${friendly}\n\nIt failed 5 times in a row, so it has been taken out of the rotation. Other mailboxes are still sending. Fix it and set it back to active on the Mailboxes screen.`,
        refType: 'mailbox',
        refId: mailbox.id,
      });
    }

    await q(`UPDATE leads SET next_send_at = NOW() + interval '30 minutes', last_error = $2 WHERE id = $1`,
      [lead.id, friendly]);
    return { result: 'error', error: friendly };
  }
}

async function computeNextSend(campaign, justSentStep) {
  const next = await one(
    'SELECT * FROM sequence_steps WHERE campaign_id=$1 AND step_no=$2',
    [campaign.id, justSentStep + 1],
  );
  if (!next) return null;                        // sequence finished
  const target = DateTime.now().plus({ days: next.day_offset });
  return nextWindowStart(campaign, target);
}

// ------------------------------------------------------------ bounce guard --
async function checkBounceGuard(campaign) {
  const row = await one(
    `SELECT
       COUNT(*) FILTER (WHERE status='bounced')::int AS bounced,
       COUNT(*) FILTER (WHERE status <> 'pending')::int AS touched
     FROM leads WHERE campaign_id = $1`,
    [campaign.id],
  );
  if (!row || row.touched < 40) return;         // too early to judge

  const rate = (row.bounced / row.touched) * 100;
  if (rate >= Number(campaign.bounce_guard)) {
    await q(`UPDATE campaigns SET status='paused', paused_reason=$2 WHERE id=$1`, [
      campaign.id,
      `Bounce rate reached ${rate.toFixed(1)}%`,
    ]);
    await raiseIssue({
      severity: 'critical',
      title: `Campaign paused: ${campaign.name}`,
      detail: `${row.bounced} of ${row.touched} addresses bounced (${rate.toFixed(1)}%). Above about 2% your sending domains start losing reputation, so the campaign stopped itself. Re-verify this list before starting it again.`,
      refType: 'campaign',
      refId: campaign.id,
    });
  }
}

// -------------------------------------------------------------------- tick --
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Anyone on the do-not-contact list is taken out of the queue before a
// single mail is composed, rather than being skipped one at a time.
async function dropBlockedLeads() {
  await q(
    `UPDATE leads l SET status='unsubscribed', next_send_at=NULL, last_error='On the do-not-contact list'
      WHERE l.status IN ('pending','active')
        AND EXISTS (
          SELECT 1 FROM blocklist b
           WHERE b.value = lower(l.email)
              OR b.value = '@' || split_part(lower(l.email), '@', 2))`,
  );
}

export async function tick() {
  await resetDailyCounters();
  await dropBlockedLeads();

  const campaigns = await q(`SELECT * FROM campaigns WHERE status = 'active' ORDER BY id`);
  const now = DateTime.now();
  const tickEndsAt = Date.now() + config.schedulerIntervalMs - 2000;

  for (const campaign of campaigns) {
    if (!inWindow(campaign, now)) continue;
    if (campaign.sent_today >= campaign.daily_limit) continue;

    // First run of the day, or the app was asleep — start pacing from now.
    let dispatchAt = campaign.next_dispatch_at ? DateTime.fromJSDate(campaign.next_dispatch_at) : null;
    if (!dispatchAt || dispatchAt < now.minus({ minutes: 20 })) dispatchAt = now;

    let sentThisTick = 0;
    let budget = campaign.daily_limit - campaign.sent_today;

    while (sentThisTick < config.maxSendsPerTick && budget > 0) {
      // Wait out the gap if the next slot falls inside this tick; otherwise
      // leave it for the next one. This is what keeps the pacing honest when
      // the gap is shorter than the tick interval.
      const waitMs = dispatchAt.toMillis() - Date.now();
      if (waitMs > 0) {
        if (Date.now() + waitMs > tickEndsAt) break;
        await sleep(waitMs);
      }

      const outcome = await dispatchOne(campaign);
      if (outcome === 'sent') {
        sentThisTick++;
        budget--;
        const gap = campaign.gap_min_sec +
          Math.random() * Math.max(0, campaign.gap_max_sec - campaign.gap_min_sec);
        dispatchAt = DateTime.now().plus({ seconds: gap });
      } else if (outcome === 'empty') {
        await maybeFinishCampaign(campaign);
        break;
      } else {
        break;                                   // no mailbox free, try next tick
      }
    }

    await q('UPDATE campaigns SET next_dispatch_at = $2 WHERE id = $1',
      [campaign.id, dispatchAt.toJSDate()]);
  }
}

async function dispatchOne(campaign) {
  const due = await q(
    `SELECT * FROM leads
      WHERE campaign_id = $1
        AND status IN ('pending','active')
        AND next_send_at IS NOT NULL
        AND next_send_at <= NOW()
      ORDER BY next_send_at ASC
      LIMIT 25`,
    [campaign.id],
  );
  if (!due.length) return 'empty';

  for (const lead of due) {
    if (await isBlocked(lead.email)) {
      await q(`UPDATE leads SET status='unsubscribed', next_send_at=NULL,
                                last_error='On the blocklist' WHERE id=$1`, [lead.id]);
      continue;
    }

    const step = await one(
      'SELECT * FROM sequence_steps WHERE campaign_id=$1 AND step_no=$2',
      [campaign.id, lead.current_step + 1],
    );
    if (!step) {
      await q(`UPDATE leads SET status='finished', next_send_at=NULL WHERE id=$1`, [lead.id]);
      continue;
    }
    // A follow-up that stays on the thread reuses the first mail's subject,
    // so only the body is required for it.
    const needsSubject = step.step_no === 1 || !step.same_thread;
    if (!step.body.trim() || (needsSubject && !step.subject.trim())) {
      await q(`UPDATE leads SET next_send_at = NOW() + interval '1 hour' WHERE id=$1`, [lead.id]);
      await raiseIssue({
        severity: 'warning',
        title: `Empty template in ${campaign.name}`,
        detail: `Step ${step.step_no} has no message written, so nothing can be sent for it. Fill it in on the campaign's Sequence tab.`,
        refType: 'campaign',
        refId: campaign.id,
      });
      continue;
    }

    const { result } = await sendToLead(campaign, lead, step);
    if (result === 'sent') return 'sent';
    if (result === 'no_mailbox') return 'no_mailbox';
    // bounced / defer_lead / error → just move on to the next lead
    if (result === 'defer_lead') {
      await q('UPDATE leads SET next_send_at = $2 WHERE id = $1',
        [lead.id, nextWindowStart(campaign)]);
    }
  }
  return 'no_mailbox';
}

async function maybeFinishCampaign(campaign) {
  const row = await one(
    `SELECT COUNT(*)::int AS open FROM leads
      WHERE campaign_id=$1 AND status IN ('pending','active')`,
    [campaign.id],
  );
  if (row && row.open === 0) {
    await q(`UPDATE campaigns SET status='done' WHERE id=$1`, [campaign.id]);
    await raiseIssue({
      severity: 'info',
      title: `Campaign finished: ${campaign.name}`,
      detail: 'Every lead has gone through the full sequence. Replies still arrive in the inbox.',
      refType: 'campaign',
      refId: campaign.id,
    });
  }
}
