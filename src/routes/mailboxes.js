import express from 'express';
import { DateTime } from 'luxon';
import { q, one } from '../db/index.js';
import { encrypt } from '../lib/crypto.js';
import { verifyMailbox, dropTransport, secureForPort } from '../lib/mailer.js';
import { effectiveLimit, warmupLabel } from '../lib/scheduler.js';
import { consentUrl, exchangeCode, storeRefreshToken, gmailConfigured } from '../lib/gmail.js';
import { config } from '../config.js';

export const mailboxRouter = express.Router();

function shape(m) {
  return {
    id: m.id,
    email: m.email,
    display_name: m.display_name,
    signature: m.signature,
    smtp_host: m.smtp_host,
    smtp_port: m.smtp_port,
    smtp_secure: m.smtp_secure,
    imap_host: m.imap_host,
    imap_port: m.imap_port,
    imap_secure: m.imap_secure,
    username: m.username,
    daily_limit: m.daily_limit,
    warmup_enabled: m.warmup_enabled,
    warmup_started_on: m.warmup_started_on,
    auth_type: m.auth_type,
    status: m.status,
    last_error: m.last_error,
    sent_today: m.sent_today,
    today_limit: effectiveLimit(m),
    warmup_label: warmupLabel(m),
    last_used_at: m.last_used_at,
    last_imap_sync_at: m.last_imap_sync_at,
  };
}

mailboxRouter.get('/', async (req, res) => {
  const rows = await q('SELECT * FROM mailboxes ORDER BY email');
  res.json(rows.map(shape));
});

mailboxRouter.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.email || !b.password) {
    return res.status(400).json({ error: 'Email address and password are both needed.' });
  }

  const check = await verifyMailbox(b);
  if (!check.ok && !b.skip_check) {
    return res.status(400).json({ error: check.error });
  }

  try {
    const row = await one(
      `INSERT INTO mailboxes
        (email, display_name, signature, smtp_host, smtp_port, smtp_secure,
         imap_host, imap_port, imap_secure, username, password_enc,
         daily_limit, warmup_enabled, warmup_started_on, quota_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        b.email.trim().toLowerCase(),
        b.display_name || b.email,
        b.signature || '',
        b.smtp_host, parseInt(b.smtp_port || 465, 10),
        secureForPort(b.smtp_port || 465, b.smtp_secure),
        b.imap_host, parseInt(b.imap_port || 993, 10), b.imap_secure !== false,
        b.username || b.email,
        encrypt(b.password),
        parseInt(b.daily_limit || 35, 10),
        b.warmup_enabled !== false,
        b.warmup_enabled === false ? null : (b.warmup_started_on || DateTime.now().toISODate()),
        DateTime.now().toISODate(),
      ],
    );
    res.json(shape(row));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'That email address is already added.' });
    }
    throw err;
  }
});

mailboxRouter.put('/:id', async (req, res) => {
  const b = req.body || {};
  const existing = await one('SELECT * FROM mailboxes WHERE id = $1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Mailbox not found.' });

  const row = await one(
    `UPDATE mailboxes SET
       display_name = COALESCE($2, display_name),
       signature = COALESCE($3, signature),
       smtp_host = COALESCE($4, smtp_host),
       smtp_port = COALESCE($5, smtp_port),
       smtp_secure = CASE WHEN $5 IS NULL THEN smtp_secure ELSE ($5 = 465) END,
       imap_host = COALESCE($6, imap_host),
       imap_port = COALESCE($7, imap_port),
       username = COALESCE($8, username),
       password_enc = COALESCE($9, password_enc),
       daily_limit = COALESCE($10, daily_limit),
       warmup_enabled = COALESCE($11, warmup_enabled),
       status = COALESCE($12, status),
       last_error = CASE WHEN $12 = 'active' THEN NULL ELSE last_error END,
       consecutive_fails = CASE WHEN $12 = 'active' THEN 0 ELSE consecutive_fails END
     WHERE id = $1 RETURNING *`,
    [
      req.params.id,
      b.display_name ?? null,
      b.signature ?? null,
      b.smtp_host ?? null,
      b.smtp_port ? parseInt(b.smtp_port, 10) : null,
      b.imap_host ?? null,
      b.imap_port ? parseInt(b.imap_port, 10) : null,
      b.username ?? null,
      b.password ? encrypt(b.password) : null,
      b.daily_limit ? parseInt(b.daily_limit, 10) : null,
      typeof b.warmup_enabled === 'boolean' ? b.warmup_enabled : null,
      b.status ?? null,
    ],
  );
  dropTransport(row.id);
  res.json(shape(row));
});

mailboxRouter.post('/:id/test', async (req, res) => {
  const m = await one('SELECT * FROM mailboxes WHERE id = $1', [req.params.id]);
  if (!m) return res.status(404).json({ error: 'Mailbox not found.' });
  const { decrypt } = await import('../lib/crypto.js');
  const result = await verifyMailbox({ ...m, password: decrypt(m.password_enc) });
  if (result.ok) {
    await q(`UPDATE mailboxes SET status='active', last_error=NULL, consecutive_fails=0 WHERE id=$1`, [m.id]);
  }
  res.json(result);
});

mailboxRouter.delete('/:id', async (req, res) => {
  await q('DELETE FROM mailboxes WHERE id = $1', [req.params.id]);
  dropTransport(Number(req.params.id));
  res.json({ ok: true });
});

// Paste all 20 mailboxes at once instead of filling the form twenty times.
mailboxRouter.post('/bulk', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const added = [];
  const failed = [];

  for (const r of rows) {
    if (!r.email || !r.password) {
      failed.push({ email: r.email || '(blank)', error: 'Missing email or password' });
      continue;
    }
    try {
      const row = await one(
        `INSERT INTO mailboxes
          (email, display_name, signature, smtp_host, smtp_port, smtp_secure,
           imap_host, imap_port, imap_secure, username, password_enc,
           daily_limit, warmup_enabled, warmup_started_on, quota_date)
         VALUES ($1,$2,$3,$4,$5,$11,$6,$7,TRUE,$1,$8,$9,TRUE,$10,$10)
         RETURNING *`,
        [
          String(r.email).trim().toLowerCase(),
          r.display_name || req.body.default_display_name || r.email,
          r.signature || req.body.default_signature || '',
          r.smtp_host || req.body.default_smtp_host,
          parseInt(r.smtp_port || req.body.default_smtp_port || 465, 10),
          r.imap_host || req.body.default_imap_host,
          parseInt(r.imap_port || req.body.default_imap_port || 993, 10),
          encrypt(r.password),
          parseInt(r.daily_limit || req.body.default_daily_limit || 35, 10),
          DateTime.now().toISODate(),
          secureForPort(r.smtp_port || req.body.default_smtp_port || 465),
        ],
      );
      added.push(shape(row));
    } catch (err) {
      failed.push({
        email: r.email,
        error: err.code === '23505' ? 'Already added' : err.message,
      });
    }
  }
  res.json({ added, failed });
});


// ------------------------------------------------------- Gmail via OAuth ---
// Sending through the Gmail API instead of SMTP. This is what makes the app
// work on hosts that block outbound SMTP, and it is the only option that can
// send as a Google account without storing its password.

mailboxRouter.get('/gmail/config', (req, res) => {
  res.json({
    configured: gmailConfigured(),
    redirect_uri: config.googleRedirectUri,
    app_url: config.appUrl,
  });
});

mailboxRouter.get('/gmail/start', (req, res) => {
  if (!gmailConfigured()) {
    return res.status(400).json({
      error: 'Google sign-in is not set up yet. Add GOOGLE_CLIENT_ID and '
        + 'GOOGLE_CLIENT_SECRET to this app\'s variables, then try again.',
    });
  }
  if (!config.appUrl) {
    return res.status(400).json({
      error: 'APP_URL is not set, so Google has nowhere to send you back to.',
    });
  }
  res.json({ url: consentUrl('connect') });
});

mailboxRouter.get('/gmail/callback', async (req, res) => {
  const done = (msg, ok) =>
    res.redirect(`/#/mailboxes?${ok ? 'connected' : 'error'}=${encodeURIComponent(msg)}`);

  if (req.query.error) return done(String(req.query.error), false);
  if (!req.query.code) return done('Google did not send a code back.', false);

  try {
    const { email, refreshToken } = await exchangeCode(String(req.query.code));

    const existing = await one('SELECT * FROM mailboxes WHERE email = $1', [email]);
    if (existing) {
      await q(
        `UPDATE mailboxes SET auth_type='gmail', oauth_refresh_enc=$2, status='active',
                last_error=NULL, consecutive_fails=0 WHERE id=$1`,
        [existing.id, storeRefreshToken(refreshToken)],
      );
      return done(`${email} reconnected`, true);
    }

    await one(
      `INSERT INTO mailboxes
        (email, display_name, signature, username, password_enc, auth_type,
         oauth_refresh_enc, smtp_port, imap_port, daily_limit, warmup_enabled, quota_date)
       VALUES ($1,$2,'',$1,'', 'gmail',$3,465,993,$4,FALSE,$5) RETURNING *`,
      [email, email, storeRefreshToken(refreshToken), 5, DateTime.now().toISODate()],
    );
    return done(`${email} connected`, true);
  } catch (err) {
    console.error('[gmail] callback failed:', err.message);
    return done(err.message, false);
  }
});
