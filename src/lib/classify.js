// Decides what an incoming mail actually is. Getting this right is what stops
// the system from sending a follow-up to someone who already replied.

const BOUNCE_SENDERS = /(mailer-daemon|postmaster|no-?reply@.*(mail|smtp)|mail delivery (subsystem|system))/i;
const BOUNCE_SUBJECTS = /(undeliverable|undelivered|delivery (status|has failed|failure|incomplete)|returned mail|mail delivery failed|failure notice|delivery notification)/i;
const HARD_BOUNCE_BODY = /(5\.1\.[1-6]|550[- ]|user unknown|no such user|does not exist|address rejected|recipient rejected|mailbox (unavailable|not found)|account has been disabled|domain not found)/i;
const SOFT_BOUNCE_BODY = /(4\.\d\.\d|450[- ]|452[- ]|mailbox full|over quota|quota exceeded|temporarily (unavailable|deferred)|try again later|greylist)/i;

const OOO_SUBJECTS = /(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|on (annual |maternity |paternity )?leave|away from (my )?(desk|email)|vacation|holiday notice|abwesenheit|absence du bureau)/i;

const UNSUB_PATTERNS = /^\s*(stop|unsubscribe|remove me|remove|opt ?out|no thanks?|not interested|do not (contact|email|mail)|don'?t (contact|email) me|take me off)\b/i;
const UNSUB_ANYWHERE = /(unsubscribe me|remove me from (your )?(list|mailing)|stop (emailing|contacting) me|do not contact me again|take me off (your )?list)/i;

export function classifyIncoming({ from, subject, body, headers }) {
  const f = String(from || '').toLowerCase();
  const s = String(subject || '');
  const b = String(body || '').slice(0, 4000);
  const h = headers || new Map();

  const hv = (name) => {
    const v = h.get ? h.get(name) : h[name];
    return v == null ? '' : String(v);
  };

  // --- bounce -------------------------------------------------------------
  const reportType = hv('content-type');
  const looksLikeReport = /delivery-status|report-type=delivery-status/i.test(reportType);

  if (BOUNCE_SENDERS.test(f) || BOUNCE_SUBJECTS.test(s) || looksLikeReport) {
    const hard = HARD_BOUNCE_BODY.test(b);
    const soft = SOFT_BOUNCE_BODY.test(b);
    return {
      kind: 'bounce',
      hard: hard || (!soft && !SOFT_BOUNCE_BODY.test(s)),
      reason: extractBounceReason(b) || s || 'Delivery failed',
    };
  }

  // --- auto reply / out of office ----------------------------------------
  const autoSubmitted = hv('auto-submitted');
  if (
    (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') ||
    hv('x-autoreply') ||
    hv('x-autorespond') ||
    hv('x-auto-response-suppress') ||
    /vacation|autoreply/i.test(hv('precedence')) ||
    OOO_SUBJECTS.test(s)
  ) {
    return { kind: 'auto_reply' };
  }

  // --- unsubscribe --------------------------------------------------------
  const firstLine = stripQuoted(b).split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  if (UNSUB_PATTERNS.test(firstLine) || UNSUB_ANYWHERE.test(stripQuoted(b))) {
    return { kind: 'unsubscribe' };
  }

  // --- a real human replied ----------------------------------------------
  return { kind: 'normal' };
}

// Drops the quoted original so "stop" in our own opt-out line is not read
// as the recipient asking to stop.
export function stripQuoted(body) {
  const text = String(body || '');
  const cutoffs = [
    /\n\s*On .{5,80}\s+wrote:/,
    /\n\s*-{2,}\s*Original Message\s*-{2,}/i,
    /\n\s*_{5,}/,
    /\n\s*From:.*\n\s*Sent:/i,
  ];
  let cut = text.length;
  for (const re of cutoffs) {
    const m = text.match(re);
    if (m && m.index < cut) cut = m.index;
  }
  return text
    .slice(0, cut)
    .split('\n')
    .filter((l) => !l.trim().startsWith('>'))
    .join('\n')
    .trim();
}

function extractBounceReason(body) {
  const m = String(body).match(/(?:Diagnostic-Code|reason|said):?\s*(?:smtp;)?\s*(.{10,180})/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

// Pulls the original recipient out of a bounce report, so we know which lead died.
export function extractBouncedAddress(body) {
  const patterns = [
    /Final-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/i,
    /Original-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/i,
    /(?:failed permanently for|to)\s+<?([^\s<>]+@[^\s<>]+)>?/i,
    /<([^\s<>]+@[^\s<>]+)>[^\n]{0,40}(?:does not exist|unknown|failed)/i,
  ];
  for (const re of patterns) {
    const m = String(body || '').match(re);
    if (m) return m[1].toLowerCase().replace(/[.,;)]$/, '');
  }
  return null;
}
