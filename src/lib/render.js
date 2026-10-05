// Turns a template into the actual text for one lead.
//
//   {{first_name}}                merge tag
//   {{first_name|there}}          merge tag with a fallback
//   {spin|one|two|three}          picks one at random, so no two mails are identical
//
// Anything unknown becomes the fallback, or an empty string — never the raw tag.

function pickSpin(text) {
  // innermost braces first, so nesting works
  const re = /\{([^{}]*\|[^{}]*)\}/;
  let out = text;
  let guard = 0;
  while (re.test(out) && guard++ < 50) {
    out = out.replace(re, (_, group) => {
      const options = group.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
  }
  return out;
}

function titleCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function leadVars(lead) {
  const extra = lead.fields && typeof lead.fields === 'object' ? lead.fields : {};
  const vars = {};
  for (const [k, v] of Object.entries(extra)) {
    vars[k.toLowerCase().replace(/\s+/g, '_')] = v == null ? '' : String(v);
  }
  vars.email = lead.email || '';
  vars.first_name = titleCase(lead.first_name || '');
  vars.last_name = titleCase(lead.last_name || '');
  vars.full_name = [vars.first_name, vars.last_name].filter(Boolean).join(' ');
  vars.company = lead.company || '';
  return vars;
}

export function render(template, lead) {
  if (!template) return '';
  const vars = leadVars(lead);

  let out = String(template).replace(/\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g, (_, key, fallback) => {
    const val = vars[String(key).toLowerCase()];
    if (val != null && String(val).trim() !== '') return String(val).trim();
    return (fallback || '').trim();
  });

  out = pickSpin(out);

  // tidy up the damage an empty merge tag leaves behind
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/ ,/g, ',');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

// Every mail must carry a way out. This is added automatically, so it can
// never be forgotten in a template.
export function withSignature(body, mailbox, optOutLine) {
  const parts = [body];
  if (mailbox.signature && mailbox.signature.trim()) {
    parts.push(mailbox.signature.trim());
  }
  if (optOutLine && optOutLine.trim()) {
    parts.push(optOutLine.trim());
  }
  return parts.join('\n\n');
}

export const DEFAULT_OPT_OUT =
  'If this is not relevant, just reply "stop" and I will not write again.';
