// Sending and reading through the Gmail API over HTTPS.
//
// This exists because many hosts (Railway's cheaper plans among them) block
// outbound SMTP entirely. The Gmail API is ordinary HTTPS, so it works there.
// It also only ever touches Google accounts — a BigRock or other mailbox still
// goes through SMTP.

import { google } from 'googleapis';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { config } from '../config.js';
import { encrypt, decrypt } from './crypto.js';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function gmailConfigured() {
  return !!(config.googleClientId && config.googleClientSecret);
}

function oauthClient(redirectUri) {
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    redirectUri || config.googleRedirectUri,
  );
}

// Step 1 of connecting a mailbox: send the person to Google.
export function consentUrl(state, redirectUri) {
  return oauthClient(redirectUri).generateAuthUrl({
    access_type: 'offline',       // we need a refresh token, not just an hour
    prompt: 'consent',            // force one even if they approved before
    scope: GMAIL_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

// Step 2: Google sends back a code; swap it for a refresh token.
export async function exchangeCode(code, redirectUri) {
  const client = oauthClient(redirectUri);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Remove this app at '
      + 'myaccount.google.com/permissions and connect the mailbox again.',
    );
  }
  client.setCredentials(tokens);
  const me = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
  return {
    email: String(me.data.email || '').toLowerCase(),
    refreshToken: tokens.refresh_token,
  };
}

function clientForMailbox(mailbox) {
  const client = oauthClient();
  client.setCredentials({ refresh_token: decrypt(mailbox.oauth_refresh_enc) });
  return google.gmail({ version: 'v1', auth: client });
}

export function storeRefreshToken(token) {
  return encrypt(token);
}

// Gmail wants the whole RFC822 message, base64url encoded.
async function buildRaw({ from, to, subject, text, inReplyTo, references }) {
  const headers = {};
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  if (references) headers.References = references;

  const mail = new MailComposer({ from, to, subject, text, headers });
  const built = await mail.compile().build();
  return built.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The two calls that actually reach Google, kept behind one object so tests
// can swap in a fake without the network. Production never replaces this.
const backend = {
  send: realSend,
  fetch: realFetch,
  verify: realVerify,
};

export function setGmailBackend(impl) {
  Object.assign(backend, impl);
}

export function sendViaGmail(args) { return backend.send(args); }
export function fetchNewGmail(mailbox, since) { return backend.fetch(mailbox, since); }
export function verifyGmail(mailbox) { return backend.verify(mailbox); }

async function realSend({ mailbox, to, subject, text, inReplyTo, references, threadId }) {
  const gmail = clientForMailbox(mailbox);
  const raw = await buildRaw({
    from: `${mailbox.display_name} <${mailbox.email}>`,
    to, subject, text, inReplyTo, references,
  });

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: threadId ? { raw, threadId } : { raw },
  });

  // send() returns ids but not headers; fetch the Message-ID so follow-ups
  // can thread against it exactly as the SMTP path does.
  let messageId = null;
  try {
    const full = await gmail.users.messages.get({
      userId: 'me', id: res.data.id, format: 'metadata',
      metadataHeaders: ['Message-ID'],
    });
    messageId = headerOf(full.data, 'message-id');
  } catch { /* not fatal — threading falls back to threadId */ }

  return { messageId, threadId: res.data.threadId, id: res.data.id };
}

async function realVerify(mailbox) {
  try {
    const gmail = clientForMailbox(mailbox);
    const profile = await gmail.users.getProfile({ userId: 'me' });
    return { ok: true, email: profile.data.emailAddress };
  } catch (err) {
    return { ok: false, error: friendlyGmailError(err) };
  }
}

function headerOf(message, name) {
  const h = (message.payload?.headers || [])
    .find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

// Walks the MIME tree for the plain-text body.
function bodyOf(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  for (const part of payload.parts || []) {
    const found = bodyOf(part);
    if (found) return found;
  }
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  return '';
}

// Incoming mail since the last check. Mirrors what the IMAP path returns so
// the rest of the system does not care which one produced it.
async function realFetch(mailbox, sinceEpochSec) {
  const gmail = clientForMailbox(mailbox);
  const after = Math.max(1, Math.floor(sinceEpochSec || (Date.now() / 1000 - 3600)));

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `-in:sent -in:draft after:${after}`,
    maxResults: 100,
  });

  const out = [];
  for (const ref of list.data.messages || []) {
    const full = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
    const m = full.data;
    const fromRaw = headerOf(m, 'from') || '';
    const match = fromRaw.match(/<([^>]+)>/);

    out.push({
      from: (match ? match[1] : fromRaw).trim().toLowerCase(),
      subject: headerOf(m, 'subject') || '',
      body: bodyOf(m.payload),
      messageId: headerOf(m, 'message-id'),
      inReplyTo: headerOf(m, 'in-reply-to'),
      references: (headerOf(m, 'references') || '').split(/\s+/).filter(Boolean),
      date: m.internalDate ? new Date(Number(m.internalDate)) : new Date(),
      threadId: m.threadId,
      headers: new Map(
        (m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]),
      ),
    });
  }
  return out;
}

export function friendlyGmailError(err) {
  const msg = String(err?.message || err);
  const code = err?.code || err?.response?.status;

  if (code === 401 || /invalid_grant|unauthorized/i.test(msg)) {
    return 'Google has revoked access for this mailbox. Connect it again from the Mailboxes screen.';
  }
  if (code === 403 && /quota|rate/i.test(msg)) {
    return 'Google is rate limiting this account. Sending will resume on its own shortly.';
  }
  if (code === 403) {
    return 'Google refused the request. Check that the Gmail API is enabled and this account is allowed on the OAuth consent screen.';
  }
  if (code === 429) {
    return 'Google is rate limiting this account. Sending will resume on its own shortly.';
  }
  if (/Daily.*limit|sending limit|exceeded/i.test(msg)) {
    return 'This Google account has hit its daily sending limit. It will reset within 24 hours.';
  }
  return msg.slice(0, 400);
}

// A bounce over the API looks the same as over SMTP: Google accepts the
// message and a delivery report arrives later, so there is no hard bounce to
// detect at send time.
export function isGmailHardBounce() {
  return false;
}
