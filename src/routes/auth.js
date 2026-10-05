import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { q, one } from '../db/index.js';
import { consentUrl, exchangeCode, storeRefreshToken, gmailConfigured } from '../lib/gmail.js';

export const authRouter = express.Router();

export function issueSession(res, who) {
  const token = jwt.sign({ ok: true, who }, config.jwtSecret, { expiresIn: '30d' });
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 3600 * 1000,
  });
}

// Who is allowed in with Google. An address that already sends from here is
// trusted; otherwise it must be on the allowlist. The one exception is a brand
// new install with no mailboxes at all, so the first person can get in.
async function maySignIn(email) {
  if (config.allowedLoginEmails.includes(email)) return true;
  const existing = await one('SELECT 1 FROM mailboxes WHERE lower(email) = $1', [email]);
  if (existing) return true;
  const any = await one('SELECT COUNT(*)::int AS c FROM mailboxes');
  return any.c === 0;
}

authRouter.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== config.appPassword) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  issueSession(res, 'password');
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  const token = req.cookies?.session;
  try {
    jwt.verify(token, config.jwtSecret);
    res.json({ authenticated: true });
  } catch {
    res.json({ authenticated: false });
  }
});

// ------------------------------------------------- sign in with Google ---
// One flow does both jobs: it signs the person in, and it connects that same
// address as a sending mailbox.

authRouter.get('/google/available', (req, res) => {
  res.json({ available: gmailConfigured() && !!config.appUrl });
});

authRouter.get('/google/start', (req, res) => {
  if (!gmailConfigured() || !config.appUrl) {
    return res.status(400).json({
      error: 'Google sign-in is not set up yet. Add APP_URL, GOOGLE_CLIENT_ID '
        + 'and GOOGLE_CLIENT_SECRET to this app\'s variables.',
    });
  }
  res.json({ url: consentUrl('login') });
});

authRouter.get('/google/callback', async (req, res) => {
  const connecting = String(req.query.state || 'login') === 'connect';
  const fail = (msg) => res.redirect(connecting
    ? `/#/mailboxes?error=${encodeURIComponent(msg)}`
    : `/#/?signin_error=${encodeURIComponent(msg)}`);

  if (req.query.error) return fail(String(req.query.error));
  if (!req.query.code) return fail('Google did not send a code back.');

  // Adding another sender only needs an existing session, not the allowlist.
  // Checked before talking to Google, so an expired session fails fast.
  if (connecting) {
    try { jwt.verify(req.cookies?.session, config.jwtSecret); }
    catch { return fail('Your session expired. Sign in again, then connect the account.'); }
  }

  try {
    const { email, refreshToken } = await exchangeCode(String(req.query.code));

    if (!connecting && !await maySignIn(email)) {
      return fail(`${email} is not allowed to sign in here. Sign in with an `
        + 'account that is already set up, then connect this one from Mailboxes.');
    }

    const enc = storeRefreshToken(refreshToken);
    const existing = await one('SELECT * FROM mailboxes WHERE lower(email) = $1', [email]);

    if (existing) {
      await q(
        `UPDATE mailboxes SET auth_type='gmail', oauth_refresh_enc=$2, status='active',
                last_error=NULL, consecutive_fails=0 WHERE id=$1`,
        [existing.id, enc],
      );
    } else {
      await q(
        `INSERT INTO mailboxes
          (email, display_name, signature, username, password_enc, auth_type,
           oauth_refresh_enc, smtp_port, imap_port, daily_limit, warmup_enabled, quota_date)
         VALUES ($1,$1,'',$1,'','gmail',$2,465,993,5,FALSE,CURRENT_DATE)`,
        [email, enc],
      );
    }

    if (!connecting) issueSession(res, email);
    res.redirect(`/#/mailboxes?connected=${encodeURIComponent(
      connecting ? `${email} connected` : `Signed in as ${email}`)}`);
  } catch (err) {
    console.error('[auth] Google sign-in failed:', err.message);
    return fail(err.message);
  }
});

export function requireAuth(req, res, next) {
  try {
    jwt.verify(req.cookies?.session, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Not signed in.' });
  }
}
