import nodemailer from 'nodemailer';
import { decrypt } from './crypto.js';
import { sendViaGmail, verifyGmail, friendlyGmailError } from './gmail.js';

const transports = new Map();

// 465 is implicit TLS; 587 and 25 start plain and upgrade with STARTTLS.
// Getting this wrong looks exactly like "cannot reach the server", so it is
// derived from the port rather than left to the person filling the form.
export function secureForPort(port, explicit) {
  if (typeof explicit === 'boolean') return explicit;
  return Number(port) === 465;
}

// 587 is the submission port and always offers STARTTLS, so insist on it
// there. On other ports, insisting would break servers that do not offer it.
function needsStartTls(port) {
  return Number(port) === 587;
}

function transportFor(mailbox) {
  const key = `${mailbox.id}:${mailbox.smtp_host}:${mailbox.smtp_port}`;
  if (transports.has(key)) return transports.get(key);

  const t = nodemailer.createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    secure: secureForPort(mailbox.smtp_port, mailbox.smtp_secure),
    requireTLS: needsStartTls(mailbox.smtp_port),
    auth: {
      user: mailbox.username || mailbox.email,
      pass: decrypt(mailbox.password_enc),
    },
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  transports.set(key, t);
  return t;
}

export function dropTransport(mailboxId) {
  for (const key of [...transports.keys()]) {
    if (key.startsWith(`${mailboxId}:`)) {
      try { transports.get(key).close(); } catch { /* already gone */ }
      transports.delete(key);
    }
  }
}

export async function verifyMailbox(mailbox) {
  if (mailbox.auth_type === 'gmail') return verifyGmail(mailbox);
  const t = nodemailer.createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    secure: secureForPort(mailbox.smtp_port, mailbox.smtp_secure),
    requireTLS: needsStartTls(mailbox.smtp_port),
    auth: { user: mailbox.username || mailbox.email, pass: mailbox.password },
    connectionTimeout: 15000,
    tls: { rejectUnauthorized: false },
  });
  try {
    await t.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlySmtpError(err) };
  } finally {
    try { t.close(); } catch { /* noop */ }
  }
}

// Plain text only, no tracking pixel, no HTML part — that is deliberate.
// A Gmail-connected mailbox goes over HTTPS; everything else over SMTP.
export async function sendMail({ mailbox, to, subject, text, inReplyTo, references, threadId }) {
  if (mailbox.auth_type === 'gmail') {
    return sendViaGmail({ mailbox, to, subject, text, inReplyTo, references, threadId });
  }
  const t = transportFor(mailbox);
  const headers = {};
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  if (references) headers.References = references;

  const info = await t.sendMail({
    from: { name: mailbox.display_name, address: mailbox.email },
    to,
    subject,
    text,
    headers,
  });

  return { messageId: info.messageId, response: info.response };
}

export function friendlySmtpError(err) {
  const msg = String(err?.message || err);
  const code = err?.responseCode || err?.code;

  // Gmail API errors arrive as HTTP statuses, not SMTP reply codes.
  if (err?.response?.status || /googleapis|invalid_grant/i.test(msg)) {
    return friendlyGmailError(err);
  }

  if (code === 'EAUTH' || /invalid login|authentication fail|535/i.test(msg)) {
    return 'Login rejected — the email address or password is wrong. If BigRock uses app passwords, create one and use that instead of the account password.';
  }
  if (code === 'EDNS' || /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return 'That mail server name does not resolve. Check the host spelling — BigRock shows it under the email account settings.';
  }
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || /timeout|ECONNREFUSED/i.test(msg)) {
    return 'Could not reach the mail server. Check the SMTP host and port (usually 465 for SSL, 587 for TLS).';
  }
  if (code === 550 || /5\.1\.1|user unknown|does not exist|no such user|recipient rejected/i.test(msg)) {
    return 'The recipient address does not exist.';
  }
  if (code === 552 || code === 452 || /quota|over limit|exceeded/i.test(msg)) {
    return 'The mail server refused the message — the sending limit for this mailbox looks used up for today.';
  }
  if (/spam|blocked|blacklist|reputation|5\.7\./i.test(msg)) {
    return 'The receiving server rejected this as spam. Check SPF, DKIM and DMARC on this domain, and slow the sending down.';
  }
  return msg.slice(0, 400);
}

// Codes that mean "this address is dead" rather than "try again later".
export function isHardBounce(err) {
  const code = err?.responseCode;
  const msg = String(err?.message || '');
  if (code >= 500 && code < 600) {
    return /5\.1\.[1-6]|user unknown|no such user|does not exist|mailbox unavailable|recipient rejected|invalid recipient/i.test(msg);
  }
  return false;
}
