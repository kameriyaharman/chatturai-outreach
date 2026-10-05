/* Chatturai Outreach — single page app, no build step. */

const app = document.getElementById('app');
const state = { route: '', data: {}, tab: 'sequence', selectedLead: null, inboxKind: 'normal',
  filter: {}, picked: new Set() };

/* ----------------------------------------------------------- helpers -- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) { renderLogin(); throw new Error('Not signed in.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Request failed.');
  return json;
}

function toast(message, bad = false) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const mins = (Date.now() - d) / 60000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.floor(mins)} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} h ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function statusChip(status) {
  const map = {
    active: ['green', 'Sending'], draft: ['grey', 'Draft'],
    paused: ['amber', 'Paused'], done: ['blue', 'Finished'],
    error: ['rust', 'Error'], pending: ['grey', 'Waiting'],
    replied: ['green', 'Replied'], bounced: ['rust', 'Bounced'],
    unsubscribed: ['pink', 'Stopped'], finished: ['blue', 'Done'],
  };
  const [tone, label] = map[status] || ['grey', status];
  return `<span class="chip ${tone}">${esc(label)}</span>`;
}

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];

/* -------------------------------------------------------------- shell -- */
function shell(body, active) {
  const unread = state.data.stats?.unread_replies || 0;
  const issues = state.data.stats?.issues?.length || 0;
  const link = (href, label, badge) => `
    <a class="navlink ${active === href ? 'on' : ''}" href="#/${href}">
      <span>${label}</span>${badge ? `<span class="pip">${badge}</span>` : ''}
    </a>`;

  app.innerHTML = `
    <div class="shell">
      <aside class="rail">
        <div class="brand"><b>Outreach</b><span>Chatturai</span></div>
        <nav>
          ${link('', 'Today', issues)}
          ${link('campaigns', 'Campaigns')}
          ${link('contacts', 'Database')}
          ${link('inbox', 'Inbox', unread)}
          ${link('mailboxes', 'Mailboxes')}
          ${link('blocklist', 'Do not contact')}
        </nav>
        <div class="foot"><a href="#" data-action="logout">Sign out</a></div>
      </aside>
      <main class="main">${body}</main>
    </div>`;
}

/* -------------------------------------------------------------- login -- */
function renderLogin() {
  app.innerHTML = `
    <div class="login"><div class="box">
      <h1>Chatturai Outreach</h1>
      <p class="sub">Sign in to run your campaigns.</p>
      <div class="panel"><div class="body">
        <label class="field"><span>Password</span>
          <input type="password" id="pw" autofocus></label>
        <button class="primary" data-action="login" style="width:100%">Sign in</button>
        <div id="loginerr" class="hint" style="color:var(--rust)"></div>
      </div></div>
    </div></div>`;
  document.getElementById('pw').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });
}

async function doLogin() {
  const password = document.getElementById('pw').value;
  try {
    await api('/auth/login', { method: 'POST', body: { password } });
    location.hash = '#/';
    route();
  } catch (err) {
    document.getElementById('loginerr').textContent = err.message;
  }
}

/* ---------------------------------------------------------- dashboard -- */
async function viewDashboard() {
  const s = await api('/stats');
  state.data.stats = s;

  const pct = s.capacity_today ? Math.min(100, (s.sent_today / s.capacity_today) * 100) : 0;
  const max = Math.max(1, ...s.series.map((d) => d.sent));

  const issues = s.issues.length ? s.issues.map((i) => `
    <div class="notice ${esc(i.severity)}">
      <b>${esc(i.title)}</b>
      <p>${esc(i.detail || '')}</p>
      <div style="margin-top:8px">
        <button class="small" data-action="resolve-issue" data-id="${i.id}">Mark as handled</button>
      </div>
    </div>`).join('') : `<div class="notice good"><b>Nothing needs your attention</b>
      <p>All mailboxes and campaigns are running normally.</p></div>`;

  shell(`
    <div class="head"><div>
      <h1>Today</h1>
      <p class="sub">${new Date().toLocaleDateString('en-IN',
      { weekday: 'long', day: 'numeric', month: 'long' })}</p>
    </div>
    <div class="actions">
      <button data-action="sync-inbox">Check for replies</button>
      <a class="btn" href="#/campaigns">Campaigns</a>
    </div></div>

    <div class="daystrip">
      <div class="count">
        <b>${s.sent_today}</b><i>/ ${s.capacity_today}</i>
        <small>mails sent today, out of what your mailboxes can safely carry</small>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="facts">
        <div><b>${s.replies_today}</b><span>replies today</span></div>
        <div><b>${s.campaigns_sending_now}/${s.campaigns_active}</b><span>campaigns sending</span></div>
        <div><b>${s.mailboxes_active}/${s.mailboxes_total}</b><span>mailboxes working</span></div>
      </div>
    </div>

    ${issues}

    <div class="panel">
      <header><h2>Last 14 days</h2>
        <span class="hint">bars are mails sent, green marks are replies</span></header>
      <div class="body">
        ${s.series.length ? `<div class="spark">
          ${s.series.map((d) => `<i class="${d.replies ? 'r' : ''}"
            style="height:${Math.max(4, (d.sent / max) * 100)}%"
            title="${d.day}: ${d.sent} sent, ${d.replies} replies"></i>`).join('')}
        </div>` : '<p class="sub" style="margin:0">Nothing sent yet.</p>'}
      </div>
    </div>`, '');
}

/* ---------------------------------------------------------- mailboxes -- */
async function viewMailboxes() {
  const rows = await api('/mailboxes');
  const gmail = await api('/mailboxes/gmail/config').catch(() => ({ configured: false }));

  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  let banner = '';
  if (params.get('connected')) {
    banner = `<div class="notice good"><b>${esc(params.get('connected'))}</b>
      <p>This account now sends through Google, so it works even where SMTP is blocked.</p></div>`;
  } else if (params.get('error')) {
    banner = `<div class="notice critical"><b>Could not connect that account</b>
      <p>${esc(params.get('error'))}</p></div>`;
  } else if (!gmail.configured) {
    banner = `<div class="notice info"><b>Google sign-in is not set up yet</b>
      <p>Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to this app's variables to connect
      Gmail and Workspace accounts without passwords. Until then, mailboxes can still be
      added with a password.</p></div>`;
  }

  const body = rows.length ? `
    <table>
      <thead><tr>
        <th>Address</th><th>Sending as</th><th>Today</th>
        <th>Speed</th><th>Status</th><th class="num"></th>
      </tr></thead>
      <tbody>${rows.map((m) => `
        <tr>
          <td><span class="mono">${esc(m.email)}</span>
            ${m.last_error ? `<div class="hint" style="color:var(--rust)">${esc(m.last_error)}</div>` : ''}</td>
          <td>${esc(m.display_name)}
            <div class="hint">${m.auth_type === 'gmail' ? 'Google account' : 'Password / SMTP'}</div></td>
          <td>${m.sent_today} / ${m.today_limit}</td>
          <td><span class="hint">${esc(m.warmup_label)}</span></td>
          <td>${statusChip(m.status)}</td>
          <td class="num" style="white-space:nowrap">
            <button class="small" data-action="test-mailbox" data-id="${m.id}">Test</button>
            <button class="small" data-action="edit-mailbox" data-id="${m.id}">Edit</button>
            ${m.status !== 'active'
    ? `<button class="small" data-action="revive-mailbox" data-id="${m.id}">Resume</button>` : ''}
          </td>
        </tr>`).join('')}</tbody>
    </table>` : `
    <div class="empty"><b>No mailboxes yet</b>
      Connect a Gmail or Google Workspace account, or add any other mailbox with its password.
      <div style="margin-top:14px" class="actions" style="justify-content:center">
        <button class="primary" data-action="connect-gmail">Connect a Google account</button>
        <button data-action="add-mailbox">Add by password</button>
      </div>
    </div>`;

  shell(`
    <div class="head"><div>
      <h1>Mailboxes</h1>
      <p class="sub">Every address here can send. A lead always keeps the mailbox it was first
      contacted from, so replies land in the right thread.</p>
    </div>
    <div class="actions">
      <button data-action="bulk-mailbox">Add many</button>
      <button data-action="add-mailbox">Add by password</button>
      <button class="primary" data-action="connect-gmail">Connect a Google account</button>
    </div></div>
    ${banner}
    <div class="panel">${body}</div>`, 'mailboxes');
}

function mailboxForm(m = {}) {
  return `
    <div class="row">
      <label class="field"><span>Email address</span>
        <input id="f_email" value="${esc(m.email || '')}" ${m.id ? 'disabled' : ''}
          placeholder="nitish@chatturai.studio"></label>
      <label class="field"><span>Password</span>
        <input id="f_password" type="password"
          placeholder="${m.id ? 'leave blank to keep the current one' : 'app password if BigRock offers one'}"></label>
    </div>
    <label class="field"><span>Name recipients will see</span>
      <input id="f_display" value="${esc(m.display_name || '')}" placeholder="Nitish Kalra — Chatturai"></label>
    <div class="row">
      <label class="field"><span>SMTP host</span>
        <input id="f_smtp_host" value="${esc(m.smtp_host || '')}" placeholder="smtp.titan.email"></label>
      <label class="field"><span>SMTP port</span>
        <select id="f_smtp_port">
          <option value="587" ${String(m.smtp_port) === '587' ? 'selected' : ''}>587 — STARTTLS (BigRock)</option>
          <option value="465" ${String(m.smtp_port || 465) === '465' ? 'selected' : ''}>465 — SSL</option>
          <option value="25"  ${String(m.smtp_port) === '25' ? 'selected' : ''}>25 — no encryption</option>
        </select>
        <small>BigRock mailboxes use 587. Encryption is set to match the port.</small></label>
      <label class="field"><span>IMAP host</span>
        <input id="f_imap_host" value="${esc(m.imap_host || '')}" placeholder="imap.titan.email"></label>
      <label class="field"><span>IMAP port</span>
        <input id="f_imap_port" type="number" value="${m.imap_port || 993}"></label>
    </div>
    <div class="row">
      <label class="field"><span>Mails per day once warmed up</span>
        <input id="f_limit" type="number" value="${m.daily_limit || 35}">
        <small>Thirty to forty is the safe ceiling for a business mailbox.</small></label>
      <label class="field"><span>Warm up automatically</span>
        <select id="f_warmup">
          <option value="true" ${m.warmup_enabled !== false ? 'selected' : ''}>Yes — ramp up over three weeks</option>
          <option value="false" ${m.warmup_enabled === false ? 'selected' : ''}>No — this mailbox is already old</option>
        </select></label>
    </div>
    <label class="field"><span>Signature</span>
      <textarea id="f_sig" placeholder="Nitish Kalra&#10;Chatturai — AI cinematic production&#10;chatturai.com">${esc(m.signature || '')}</textarea>
      <small>Added to the bottom of every mail from this address.</small></label>`;
}

async function addMailbox(existing) {
  openDialog({
    title: existing ? 'Edit mailbox' : 'Add mailbox',
    body: mailboxForm(existing || {}),
    confirm: existing ? 'Save changes' : 'Test and add',
    onConfirm: async () => {
      const payload = {
        email: document.getElementById('f_email').value.trim(),
        password: document.getElementById('f_password').value,
        display_name: document.getElementById('f_display').value.trim(),
        smtp_host: document.getElementById('f_smtp_host').value.trim(),
        smtp_port: document.getElementById('f_smtp_port').value,
        imap_host: document.getElementById('f_imap_host').value.trim(),
        imap_port: document.getElementById('f_imap_port').value,
        daily_limit: document.getElementById('f_limit').value,
        warmup_enabled: document.getElementById('f_warmup').value === 'true',
        signature: document.getElementById('f_sig').value,
      };
      if (existing) {
        if (!payload.password) delete payload.password;
        await api(`/mailboxes/${existing.id}`, { method: 'PUT', body: payload });
        toast('Mailbox saved.');
      } else {
        await api('/mailboxes', { method: 'POST', body: payload });
        toast('Mailbox added and the login works.');
      }
      viewMailboxes();
    },
  });
}

function bulkMailboxDialog() {
  openDialog({
    title: 'Add many mailboxes',
    wide: true,
    body: `
      <p class="sub">One mailbox per line: <b>email, password</b>. Everything else comes from
      the defaults below, so twenty mailboxes on the same host take one paste.</p>
      <label class="field"><span>Mailboxes</span>
        <textarea id="b_rows" style="min-height:170px" class="mono"
placeholder="nitish@chatturai.studio, mypassword123
akash@chatturai.studio, otherpassword
hello@getchatturai.com, thirdpassword"></textarea></label>
      <div class="row">
        <label class="field"><span>SMTP host</span>
          <input id="b_smtp" placeholder="smtp.titan.email"></label>
        <label class="field"><span>SMTP port</span>
          <select id="b_smtp_port">
            <option value="587">587 — STARTTLS (BigRock)</option>
            <option value="465">465 — SSL</option>
          </select></label>
        <label class="field"><span>IMAP host</span>
          <input id="b_imap" placeholder="imap.titan.email"></label>
        <label class="field"><span>IMAP port</span><input id="b_imap_port" type="number" value="993"></label>
      </div>
      <div class="row">
        <label class="field"><span>Name recipients will see</span>
          <input id="b_display" placeholder="Nitish Kalra — Chatturai"></label>
        <label class="field"><span>Mails per day each</span>
          <input id="b_limit" type="number" value="35"></label>
      </div>
      <label class="field"><span>Signature for all of them</span>
        <textarea id="b_sig"></textarea></label>`,
    confirm: 'Add them',
    onConfirm: async () => {
      const rows = document.getElementById('b_rows').value.split('\n')
        .map((line) => line.trim()).filter(Boolean)
        .map((line) => {
          const [email, ...rest] = line.split(/[,\t]/);
          return { email: (email || '').trim(), password: rest.join(',').trim() };
        });
      if (!rows.length) throw new Error('Paste at least one line.');

      const out = await api('/mailboxes/bulk', {
        method: 'POST',
        body: {
          rows,
          default_smtp_host: document.getElementById('b_smtp').value.trim(),
          default_smtp_port: document.getElementById('b_smtp_port').value,
          default_imap_host: document.getElementById('b_imap').value.trim(),
          default_imap_port: document.getElementById('b_imap_port').value,
          default_display_name: document.getElementById('b_display').value.trim(),
          default_daily_limit: document.getElementById('b_limit').value,
          default_signature: document.getElementById('b_sig').value,
        },
      });
      toast(`${out.added.length} added${out.failed.length ? `, ${out.failed.length} skipped` : ''}.`);
      if (out.failed.length) console.warn('Skipped:', out.failed);
      viewMailboxes();
    },
  });
}

/* ---------------------------------------------------------- campaigns -- */
async function viewCampaigns() {
  const rows = await api('/campaigns');

  const body = rows.length ? `
    <table>
      <thead><tr><th>Campaign</th><th>Status</th><th class="num">Leads</th>
        <th class="num">Sent</th><th class="num">Replied</th><th class="num">Bounced</th>
        <th class="num"></th></tr></thead>
      <tbody>${rows.map((c) => `
        <tr class="clickable" data-action="open-campaign" data-id="${c.id}">
          <td><b>${esc(c.name)}</b>
            <div class="hint">${c.send_days.map((d) => DAYS.find((x) => x[0] === d)?.[1]).join(' ')}
              · ${String(c.window_start).slice(0, 5)}–${String(c.window_end).slice(0, 5)}</div>
            ${c.paused_reason ? `<div class="hint" style="color:var(--rust)">${esc(c.paused_reason)}</div>` : ''}</td>
          <td>${statusChip(c.status)}${c.sending_now ? ' <span class="chip green">live</span>' : ''}</td>
          <td class="num">${c.stats.total}</td>
          <td class="num">${c.stats.sent}</td>
          <td class="num">${c.stats.replied} <span class="hint">${c.stats.reply_rate}%</span></td>
          <td class="num">${c.stats.bounced}
            <span class="hint" style="${c.stats.bounce_rate > 2 ? 'color:var(--rust)' : ''}">${c.stats.bounce_rate}%</span></td>
          <td class="num">
            ${c.status === 'active'
    ? `<button class="small" data-action="pause-campaign" data-id="${c.id}">Pause</button>`
    : `<button class="small primary" data-action="start-campaign" data-id="${c.id}">Start</button>`}
          </td>
        </tr>`).join('')}</tbody>
    </table>` : `
    <div class="empty"><b>No campaigns yet</b>
      A campaign holds one list, one sequence of mails and one sending schedule.
      <div style="margin-top:14px"><button class="primary" data-action="new-campaign">Create the first one</button></div>
    </div>`;

  shell(`
    <div class="head"><div><h1>Campaigns</h1>
      <p class="sub">Each campaign has its own leads, its own four mails and its own sending days.</p></div>
      <button class="primary" data-action="new-campaign">New campaign</button></div>
    <div class="panel">${body}</div>`, 'campaigns');
}

async function newCampaign() {
  const mailboxes = await api('/mailboxes');
  openDialog({
    title: 'New campaign',
    body: `
      <label class="field"><span>Name</span>
        <input id="c_name" placeholder="Wedding venues — Delhi NCR" autofocus></label>
      <div class="row">
        <label class="field"><span>Sending days</span>
          <div class="daypicker">${DAYS.map(([n, label]) => `
            <label class="${n <= 5 ? 'on' : ''}"><input type="checkbox" value="${n}"
              ${n <= 5 ? 'checked' : ''} data-day>${label}</label>`).join('')}</div></label>
      </div>
      <div class="row">
        <label class="field"><span>From</span><input id="c_from" type="time" value="10:00"></label>
        <label class="field"><span>Until</span><input id="c_to" type="time" value="18:00"></label>
        <label class="field"><span>Most mails per day</span><input id="c_limit" type="number" value="200"></label>
      </div>
      <label class="field"><span>Send from these mailboxes</span>
        <div style="max-height:150px;overflow:auto;border:1px solid var(--rule);border-radius:3px;padding:8px">
          ${mailboxes.length ? mailboxes.map((m) => `
            <label style="display:block;padding:3px 0;font-size:14px">
              <input type="checkbox" value="${m.id}" checked data-mb>
              <span class="mono">${esc(m.email)}</span></label>`).join('')
    : '<span class="hint">Add mailboxes first.</span>'}
        </div></label>`,
    confirm: 'Create',
    onConfirm: async () => {
      const days = [...document.querySelectorAll('[data-day]:checked')].map((i) => +i.value);
      const mbs = [...document.querySelectorAll('[data-mb]:checked')].map((i) => +i.value);
      const c = await api('/campaigns', {
        method: 'POST',
        body: {
          name: document.getElementById('c_name').value.trim(),
          send_days: days.length ? days : [1, 2, 3, 4, 5],
          window_start: document.getElementById('c_from').value,
          window_end: document.getElementById('c_to').value,
          daily_limit: document.getElementById('c_limit').value,
          mailbox_ids: mbs,
        },
      });
      location.hash = `#/campaign/${c.id}`;
    },
  });
}

/* ----------------------------------------------------- campaign detail -- */
async function viewCampaign(id) {
  const c = await api(`/campaigns/${id}`);
  state.data.campaign = c;

  const tabs = ['sequence', 'leads', 'settings'];
  const tabBody = {
    sequence: sequenceTab(c),
    leads: await leadsTab(c),
    settings: settingsTab(c),
  }[state.tab] || sequenceTab(c);

  shell(`
    <div class="head"><div>
      <h1>${esc(c.name)}</h1>
      <p class="sub">
        ${c.stats.total} leads · ${c.stats.sent} sent · ${c.stats.replied} replied
        (${c.stats.reply_rate}%) · ${c.stats.bounced} bounced (${c.stats.bounce_rate}%)
      </p></div>
      <div class="actions">
        ${statusChip(c.status)}
        ${c.status === 'active'
    ? `<button data-action="pause-campaign" data-id="${c.id}">Pause</button>`
    : `<button class="primary" data-action="start-campaign" data-id="${c.id}">Start sending</button>`}
        <a class="btn" href="#/campaigns">All campaigns</a>
      </div></div>

    ${c.paused_reason ? `<div class="notice critical"><b>Stopped</b><p>${esc(c.paused_reason)}</p></div>` : ''}
    ${c.capacity_per_day < c.daily_limit ? `<div class="notice warning">
      <b>These settings top out at about ${c.capacity_per_day} mails a day</b>
      <p>The daily limit is set to ${c.daily_limit}. Widen the sending window or shorten the gap
      between mails if you need the full number.</p></div>` : ''}

    <div class="tabs">${tabs.map((t) => `
      <button class="${state.tab === t ? 'on' : ''}" data-action="tab" data-tab="${t}">
        ${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    ${tabBody}`, 'campaigns');
}

function sequenceTab(c) {
  const steps = c.steps.length ? c.steps : [];
  return `
    <p class="sub">The first mail goes out when a lead starts. Each follow-up waits the number of
    days shown, and stops the moment that person replies. Use
    <span class="mono">{{first_name}}</span>, <span class="mono">{{company}}</span> or any column
    from your CSV. Write <span class="mono">{Hi|Hello|Hey}</span> to vary a line so no two mails
    are identical.</p>

    ${steps.map((s) => `
      <div class="panel">
        <header>
          <h2>${s.step_no === 1 ? 'First mail' : `Follow-up ${s.step_no - 1}`}</h2>
          <span class="hint">${s.step_no === 1 ? 'sent straight away'
    : `${s.day_offset} days after the previous mail`}</span>
        </header>
        <div class="body">
          ${s.step_no > 1 ? `<div class="row">
            <label class="field"><span>Days to wait</span>
              <input type="number" min="1" value="${s.day_offset}" data-step="${s.step_no}" data-key="day_offset"></label>
            <label class="field"><span>Thread</span>
              <select data-step="${s.step_no}" data-key="same_thread">
                <option value="true" ${s.same_thread ? 'selected' : ''}>Reply on the same thread</option>
                <option value="false" ${!s.same_thread ? 'selected' : ''}>Start a new thread</option>
              </select></label></div>` : ''}
          ${!(s.step_no > 1 && s.same_thread) ? `
            <label class="field"><span>Subject</span>
              <input value="${esc(s.subject)}" data-step="${s.step_no}" data-key="subject"
                placeholder="Quick question about {{company}}'s next film"></label>`
    : '<p class="hint" style="margin:0 0 12px">Keeps the first mail\'s subject, with “Re:” in front.</p>'}
          <label class="field"><span>Message</span>
            <textarea data-step="${s.step_no}" data-key="body" style="min-height:150px"
              placeholder="Hi {{first_name|there}},&#10;&#10;...">${esc(s.body)}</textarea>
            <small>Plain text only. Sixty to eighty words works best. No attachments, and keep
            links out of the first mail. The opt-out line is added for you.</small></label>
        </div>
      </div>`).join('')}

    <div class="actions">
      <button class="primary" data-action="save-steps">Save sequence</button>
      <button data-action="preview-steps">Preview</button>
    </div>`;
}

async function leadsTab(c) {
  const { rows, total } = await api(`/leads?campaign_id=${c.id}&limit=100`);
  return `
    <div class="head"><div>
      <h2>${total} leads</h2>
      <p class="sub">${c.stats.pending} waiting · ${c.stats.in_sequence} part-way through ·
        ${c.stats.replied} replied · ${c.stats.finished} finished</p></div>
      <div class="actions">
        <button data-action="import-leads">Import CSV</button>
        <button class="primary" data-action="assign-from-db">Assign from database</button>
      </div></div>

    <div class="panel">${rows.length ? `
      <table><thead><tr><th>Email</th><th>Name</th><th>Company</th>
        <th>Status</th><th class="num">Step</th><th>Next mail</th><th class="num"></th></tr></thead>
        <tbody>${rows.map((l) => `<tr>
          <td><span class="mono">${esc(l.email)}</span>
            ${l.last_error ? `<div class="hint" style="color:var(--rust)">${esc(l.last_error)}</div>` : ''}</td>
          <td>${esc(l.first_name)}</td>
          <td>${esc(l.company)}</td>
          <td>${statusChip(l.status)}</td>
          <td class="num">${l.current_step || '—'}</td>
          <td class="hint">${l.next_send_at ? new Date(l.next_send_at)
    .toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
          <td class="num">
            ${l.status === 'replied' || l.status === 'active'
    ? `<button class="small" data-action="open-thread" data-id="${l.id}">Open</button>` : ''}
            <button class="small danger" data-action="stop-lead" data-id="${l.id}">Stop</button>
          </td></tr>`).join('')}</tbody></table>
      ${total > rows.length ? `<div class="body hint">Showing the newest ${rows.length} of ${total}.</div>` : ''}`
    : `<div class="empty"><b>No leads yet</b>
        Upload the CSV you already have. Duplicates and blocked addresses are dropped for you.
        <div style="margin-top:14px" class="actions" style="justify-content:center">
          <button data-action="import-leads">Import CSV</button>
          <button class="primary" data-action="assign-from-db">Assign from database</button></div>
      </div>`}</div>`;
}

function settingsTab(c) {
  return `
    <div class="panel"><header><h2>Schedule</h2></header><div class="body">
      <label class="field"><span>Sending days</span>
        <div class="daypicker">${DAYS.map(([n, label]) => `
          <label class="${c.send_days.includes(n) ? 'on' : ''}">
            <input type="checkbox" value="${n}" ${c.send_days.includes(n) ? 'checked' : ''} data-day>
            ${label}</label>`).join('')}</div></label>
      <div class="row">
        <label class="field"><span>From</span>
          <input id="s_from" type="time" value="${String(c.window_start).slice(0, 5)}"></label>
        <label class="field"><span>Until</span>
          <input id="s_to" type="time" value="${String(c.window_end).slice(0, 5)}"></label>
        <label class="field"><span>Time zone</span>
          <input id="s_tz" value="${esc(c.timezone)}"></label>
      </div>
      <div class="row">
        <label class="field"><span>Most mails per day</span>
          <input id="s_limit" type="number" value="${c.daily_limit}"></label>
        <label class="field"><span>Shortest gap between mails</span>
          <input id="s_gapmin" type="number" value="${c.gap_min_sec}">
          <small>seconds</small></label>
        <label class="field"><span>Longest gap</span>
          <input id="s_gapmax" type="number" value="${c.gap_max_sec}">
          <small>seconds — the actual gap is random in between, so it never looks automated</small></label>
      </div>
      <div class="notice info"><b>These settings can carry about ${c.capacity_per_day} mails a day</b>
        <p>Worked out from the sending window and the gap between mails.</p></div>
    </div></div>

    <div class="panel"><header><h2>Mailboxes</h2></header><div class="body">
      <p class="sub">Only these addresses will send for this campaign.</p>
      <div id="s_mailboxes" class="hint">Loading…</div>
    </div></div>

    <div class="panel"><header><h2>Safety</h2></header><div class="body">
      <label class="field"><span>Stop the campaign if bounces reach</span>
        <input id="s_bounce" type="number" step="0.5" value="${c.bounce_guard}">
        <small>percent — above about 2% your sending domains start losing reputation</small></label>
    </div></div>

    <div class="actions">
      <button class="primary" data-action="save-settings">Save settings</button>
      <button class="danger" data-action="delete-campaign" data-id="${c.id}">Delete campaign</button>
    </div>`;
}

async function paintSettingsMailboxes(c) {
  const box = document.getElementById('s_mailboxes');
  if (!box) return;
  const all = await api('/mailboxes');
  const chosen = new Set(c.mailboxes.map((m) => m.id));
  box.innerHTML = all.map((m) => `
    <label style="display:block;padding:3px 0;font-size:14px">
      <input type="checkbox" value="${m.id}" ${chosen.has(m.id) ? 'checked' : ''} data-mb>
      <span class="mono">${esc(m.email)}</span>
      <span class="hint">${m.sent_today}/${m.today_limit} today</span></label>`).join('');
}

/* ------------------------------------------------------ CSV importing -- */
function importLeadsDialog(campaignId) {
  openDialog({
    title: 'Import leads',
    wide: true,
    body: `
      <label class="field"><span>CSV file</span><input type="file" id="csvfile" accept=".csv,.txt"></label>
      <div id="mapzone"></div>`,
    confirm: 'Import',
    confirmDisabled: true,
    onConfirm: async () => {
      const rows = window.__csvRows || [];
      const mapping = {};
      document.querySelectorAll('[data-map]').forEach((sel) => {
        if (sel.value) mapping[sel.dataset.map] = sel.value;
      });
      if (!mapping.email) throw new Error('Tell the importer which column holds the email address.');

      const mapped = rows.map((r) => {
        const out = {};
        for (const [field, col] of Object.entries(mapping)) out[field] = r[col];
        for (const [k, v] of Object.entries(r)) {
          if (!Object.values(mapping).includes(k)) out[k.toLowerCase().replace(/\s+/g, '_')] = v;
        }
        return out;
      });

      let report = { added: 0, duplicate: 0, invalid: 0, blocked: 0, role: 0 };
      for (let i = 0; i < mapped.length; i += 500) {
        const part = await api('/leads/import', {
          method: 'POST',
          body: { campaign_id: campaignId, rows: mapped.slice(i, i + 500) },
        });
        for (const k of Object.keys(report)) report[k] += part[k];
      }
      toast(`${report.added} leads imported. Skipped: ${report.duplicate} duplicate, `
        + `${report.invalid} invalid, ${report.role} role addresses, ${report.blocked} blocked.`);
      state.tab = 'leads';
      viewCampaign(campaignId);
    },
  });

  document.getElementById('csvfile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (out) => {
        window.__csvRows = out.data;
        const cols = out.meta.fields || [];
        const guess = (...names) => cols.find((c) =>
          names.some((n) => c.toLowerCase().replace(/[^a-z]/g, '').includes(n))) || '';

        const picker = (field, label, guessed) => `
          <label class="field"><span>${label}</span>
            <select data-map="${field}">
              <option value="">— not in this file —</option>
              ${cols.map((c) => `<option value="${esc(c)}" ${c === guessed ? 'selected' : ''}>${esc(c)}</option>`).join('')}
            </select></label>`;

        document.getElementById('mapzone').innerHTML = `
          <div class="notice info"><b>${out.data.length} rows found</b>
            <p>Check that each column is pointing at the right thing. Any column you leave
            unmapped still comes across and can be used as a merge tag.</p></div>
          <div class="row">
            ${picker('email', 'Email address', guess('email', 'mail'))}
            ${picker('first_name', 'First name', guess('firstname', 'fname', 'name'))}
            ${picker('last_name', 'Last name', guess('lastname', 'surname'))}
            ${picker('company', 'Company', guess('company', 'organisation', 'organization', 'business'))}
          </div>`;
        document.querySelector('[data-action="dialog-confirm"]').disabled = false;
      },
      error: () => toast('That file could not be read as CSV.', true),
    });
  });
}

/* ---------------------------------------------------------- the inbox -- */
async function viewInbox() {
  const { rows, counts } = await api(`/inbox?kind=${state.inboxKind}`);
  state.data.stats = { ...(state.data.stats || {}), unread_replies: counts.unread_replies };

  const filters = [
    ['normal', 'Replies', counts.replies],
    ['bounce', 'Bounces', counts.bounces],
    ['auto_reply', 'Out of office', counts.auto_replies],
    ['unsubscribe', 'Asked to stop', counts.unsubscribes],
  ];

  const list = rows.length ? rows.map((m) => `
    <div class="msg ${m.is_read ? '' : 'unread'} ${state.selectedLead === m.lead_id ? 'on' : ''}"
         data-action="open-thread" data-id="${m.lead_id || ''}">
      <b>${esc(m.first_name || m.from_addr)}</b>
      <span>${esc(m.company || m.from_addr)} · ${esc(m.campaign_name || 'no campaign')} · ${when(m.sent_at)}</span>
      <p>${esc(m.subject || '')}</p>
    </div>`).join('') : '<div class="empty">Nothing here yet.</div>';

  shell(`
    <div class="head"><div><h1>Inbox</h1>
      <p class="sub">Replies from all ${state.data.stats?.mailboxes_total || ''} mailboxes in one
      place. Anyone who replies is taken out of the follow-up queue automatically.</p></div>
      <button data-action="sync-inbox">Check now</button></div>

    <div class="tabs">${filters.map(([k, label, n]) => `
      <button class="${state.inboxKind === k ? 'on' : ''}" data-action="inbox-filter" data-kind="${k}">
        ${label}${n ? ` (${n})` : ''}</button>`).join('')}</div>

    <div class="inbox">
      <div class="panel msglist">${list}</div>
      <div class="panel" id="threadpane">
        <div class="empty">Pick a message to read the whole conversation.</div>
      </div>
    </div>`, 'inbox');

  if (state.selectedLead) openThread(state.selectedLead);
}

async function openThread(leadId) {
  if (!leadId) return;
  state.selectedLead = Number(leadId);
  const pane = document.getElementById('threadpane');
  if (!pane) { location.hash = '#/inbox'; return; }

  const { lead, messages } = await api(`/inbox/thread/${leadId}`);

  pane.innerHTML = `
    <header>
      <div>
        <h2>${esc(lead.first_name || lead.email)} ${statusChip(lead.status)}</h2>
        <div class="hint mono">${esc(lead.email)}</div>
        <div class="hint">${esc(lead.company || '')}${lead.company ? ' · ' : ''}
          ${esc(lead.campaign_name || '')} · from ${esc(lead.mailbox_email || '')}</div>
      </div>
      <button class="small danger" data-action="stop-lead" data-id="${lead.id}">Never mail again</button>
    </header>
    <div style="max-height:44vh;overflow:auto">
      ${messages.map((m) => `
        <div class="bubble ${m.direction}">
          <header>
            <span>${m.direction === 'out' ? `You → ${esc(m.to_addr)}` : esc(m.from_addr)}</span>
            <span>${new Date(m.sent_at).toLocaleString('en-IN',
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          </header>
          <div class="hint" style="margin-bottom:6px">${esc(m.subject || '')}</div>
          <pre>${esc(m.body || '')}</pre>
        </div>`).join('')}
    </div>
    <div class="body" style="border-top:1px solid var(--rule)">
      <textarea id="replytext" placeholder="Write your reply…"></textarea>
      <div class="actions" style="margin-top:9px">
        <button class="primary" data-action="send-reply" data-id="${lead.id}">Send reply</button>
        <span class="hint">Goes out from ${esc(lead.mailbox_email || '')}, on the same thread.</span>
      </div>
    </div>`;
}


/* ----------------------------------------------------- the database -- */
async function viewContacts() {
  const facets = await api('/contacts/facets');
  const params = new URLSearchParams(
    Object.entries(state.filter).filter(([, v]) => v !== '' && v != null));
  params.set('limit', '40');
  const { rows, matching } = await api(`/contacts?${params}`);

  const HIST = {
    fresh: 'Never contacted', contacted: 'Contacted before', opened: 'Opened, no reply',
    replied: 'Replied before', interested: 'Said interested', bounced: 'Bounced',
    unsubscribed: 'Asked to stop', not_interested: 'Not interested',
  };
  const TONE = {
    fresh: 'green', contacted: 'grey', opened: 'blue', replied: 'blue',
    interested: 'green', bounced: 'rust', unsubscribed: 'pink', not_interested: 'pink',
  };

  const opts = (list, sel) => list.map((o) =>
    `<option value="${esc(o.value)}" ${o.value === sel ? 'selected' : ''}>
       ${esc(o.value)} (${o.n})</option>`).join('');

  const histChips = facets.history.map((h) => `
    <label class="${(state.filter.history || '').split(',').includes(h.value) ? 'on' : ''}">
      <input type="checkbox" value="${h.value}" data-hist
        ${(state.filter.history || '').split(',').includes(h.value) ? 'checked' : ''}>
      ${esc(HIST[h.value] || h.value)} · ${h.n}</label>`).join('');

  shell(`
    <div class="head"><div><h1>Database</h1>
      <p class="sub">Every contact you have ever uploaded, in one place. Filter down to the
      people you want, then assign them to a campaign. Bounced addresses and anyone who asked
      to stop are held back automatically.</p></div>
      <button class="primary" data-action="import-contacts">Import CSV</button></div>

    <div class="daystrip">
      <div class="count"><b>${facets.total.toLocaleString('en-IN')}</b>
        <small>contacts in the database · ${facets.fresh.toLocaleString('en-IN')} never contacted</small>
      </div>
      <div class="facts">
        <div><b>${matching.toLocaleString('en-IN')}</b><span>match your filter</span></div>
        <div><b>${facets.recently_verified.toLocaleString('en-IN')}</b><span>verified in last 90 days</span></div>
      </div>
    </div>

    ${facets.recently_verified < facets.total * 0.5 ? `
      <div class="notice warning"><b>Most of this database has not been verified recently</b>
      <p>Business addresses go dead at roughly 2–3% a month. Sending to a list that was
      verified long ago is the fastest way to lose a sending domain. Re-verify before a
      large campaign.</p></div>` : ''}

    <div class="panel"><header><h2>Filter</h2>
      <button class="small" data-action="clear-filter">Clear all</button></header>
      <div class="body">
        <div class="row">
          <label class="field"><span>Search</span>
            <input id="f_search" value="${esc(state.filter.search || '')}"
              placeholder="name, company, email or job title"></label>
          <label class="field"><span>Industry</span>
            <select id="f_industry"><option value="">Any industry</option>
              ${opts(facets.industries, state.filter.industry)}</select></label>
          <label class="field"><span>Location</span>
            <select id="f_location"><option value="">Anywhere</option>
              ${opts(facets.locations, state.filter.location)}</select></label>
        </div>
        <div class="row">
          <label class="field"><span>Job title contains</span>
            <input id="f_job" value="${esc(state.filter.job_title || '')}"
              placeholder="founder, head of marketing, CMO"></label>
          <label class="field"><span>Upload</span>
            <select id="f_list"><option value="">Any upload</option>
              ${opts(facets.lists, state.filter.list_name)}</select></label>
        </div>
        <label class="field"><span>History</span>
          <div class="daypicker">${histChips}</div>
          <small>Leave all unticked to include everything that is still safe to mail.</small></label>
        <div class="actions">
          <button class="primary" data-action="apply-filter">Apply filter</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <header>
        <h2>${matching.toLocaleString('en-IN')} contacts ready to assign</h2>
        <button class="primary" data-action="assign-contacts" ${matching ? '' : 'disabled'}>
          Assign to a campaign</button>
      </header>
      ${rows.length ? `
        <table><thead><tr><th>Email</th><th>Name</th><th>Company</th>
          <th>Job title</th><th>Location</th><th>History</th></tr></thead>
          <tbody>${rows.map((c) => `<tr>
            <td class="mono">${esc(c.email)}</td>
            <td>${esc(c.first_name)} ${esc(c.last_name)}</td>
            <td>${esc(c.company)}</td>
            <td class="hint">${esc(c.job_title)}</td>
            <td class="hint">${esc(c.location)}</td>
            <td><span class="chip ${TONE[c.history] || 'grey'}">${esc(HIST[c.history] || c.history)}</span></td>
          </tr>`).join('')}</tbody></table>
        <div class="body hint">Showing the first ${rows.length}. Assigning uses the whole
          ${matching.toLocaleString('en-IN')}, not just what is on screen.</div>`
    : '<div class="empty"><b>Nothing matches</b>Loosen the filter, or import a CSV.</div>'}
    </div>`, 'contacts');
}

function readFilter() {
  const hist = [...document.querySelectorAll('[data-hist]:checked')].map((i) => i.value);
  state.filter = {
    search: document.getElementById('f_search').value.trim(),
    industry: document.getElementById('f_industry').value,
    location: document.getElementById('f_location').value,
    job_title: document.getElementById('f_job').value.trim(),
    list_name: document.getElementById('f_list').value,
    history: hist.join(','),
  };
}

async function assignDialog() {
  const campaigns = await api('/campaigns');
  const params = new URLSearchParams(
    Object.entries(state.filter).filter(([, v]) => v !== '' && v != null));
  params.set('limit', '1');
  const { matching } = await api(`/contacts?${params}`);

  openDialog({
    title: 'Assign to a campaign',
    body: `
      <p class="sub"><b>${matching.toLocaleString('en-IN')}</b> contacts match your filter.
      Anyone already sitting in a live campaign is left out, so nobody gets mail from two
      campaigns at once.</p>
      <label class="field"><span>Campaign</span>
        <select id="a_campaign">
          ${campaigns.length ? campaigns.map((c) =>
    `<option value="${c.id}">${esc(c.name)} — ${c.stats.total} leads now</option>`).join('')
    : '<option value="">Create a campaign first</option>'}
        </select></label>
      <label class="field"><span>How many to assign</span>
        <input id="a_count" type="number" value="${Math.min(matching, 1000)}" max="${matching}">
        <small>Fresh contacts are taken first. Add more later whenever the campaign runs dry.</small></label>
      <div id="a_runway" class="hint"></div>`,
    confirm: 'Assign',
    onConfirm: async () => {
      const campaignId = document.getElementById('a_campaign').value;
      if (!campaignId) throw new Error('Create a campaign first.');
      const out = await api('/contacts/assign', {
        method: 'POST',
        body: {
          campaign_id: +campaignId,
          count: +document.getElementById('a_count').value,
          filter: state.filter,
        },
      });
      const r = await api(`/contacts/runway/${campaignId}`);
      toast(`${out.assigned} assigned to ${out.campaign}` +
        (out.skipped ? `, ${out.skipped} skipped` : '') +
        ` — about ${r.working_days} working days of sending.`);
      viewContacts();
    },
  });
}

function importContactsDialog() {
  openDialog({
    title: 'Import contacts',
    wide: true,
    body: `
      <label class="field"><span>Name this upload</span>
        <input id="i_list" placeholder="Fintech founders — Sept 2026">
        <small>Lets you filter by this batch later.</small></label>
      <label class="field"><span>CSV file</span>
        <input type="file" id="cfile" accept=".csv,.txt"></label>
      <div id="cmap"></div>`,
    confirm: 'Import',
    confirmDisabled: true,
    onConfirm: async () => {
      const rows = window.__contactRows || [];
      const mapping = {};
      document.querySelectorAll('[data-cmap]').forEach((sel) => {
        if (sel.value) mapping[sel.dataset.cmap] = sel.value;
      });
      if (!mapping.email) throw new Error('Tell the importer which column holds the email address.');

      const mapped = rows.map((r) => {
        const out = {};
        for (const [field, col] of Object.entries(mapping)) out[field] = r[col];
        return out;
      });

      const report = { added: 0, updated: 0, invalid: 0, role: 0, blocklisted: 0 };
      const btn = document.querySelector('[data-action="dialog-confirm"]');
      for (let i = 0; i < mapped.length; i += 2000) {
        btn.textContent = `Importing ${i.toLocaleString('en-IN')} / ${mapped.length.toLocaleString('en-IN')}…`;
        const part = await api('/contacts/import', {
          method: 'POST',
          body: {
            rows: mapped.slice(i, i + 2000),
            list_name: document.getElementById('i_list').value.trim(),
          },
        });
        for (const k of Object.keys(report)) report[k] += part[k] || 0;
      }
      toast(`${report.added} added, ${report.updated} updated. `
        + `${report.blocklisted} put on do-not-contact, ${report.invalid} invalid, `
        + `${report.role} role addresses skipped.`);
      viewContacts();
    },
  });

  document.getElementById('cfile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (out) => {
        window.__contactRows = out.data;
        const cols = out.meta.fields || [];
        const guess = (...names) => cols.find((c) =>
          names.some((n) => c.toLowerCase().replace(/[^a-z]/g, '') === n))
          || cols.find((c) => names.some((n) => c.toLowerCase().replace(/[^a-z]/g, '').includes(n)))
          || '';

        const pick = (field, label, guessed) => `
          <label class="field"><span>${label}</span>
            <select data-cmap="${field}">
              <option value="">— not in this file —</option>
              ${cols.map((c) => `<option value="${esc(c)}" ${c === guessed ? 'selected' : ''}>${esc(c)}</option>`).join('')}
            </select></label>`;

        document.getElementById('cmap').innerHTML = `
          <div class="notice info"><b>${out.data.length.toLocaleString('en-IN')} rows found</b>
            <p>Check the mapping below. The history column matters most — it is what stops
            an address that already bounced from being mailed again.</p></div>
          <div class="row">
            ${pick('email', 'Email', guess('email'))}
            ${pick('first_name', 'First name', guess('firstname', 'fname'))}
            ${pick('last_name', 'Last name', guess('lastname', 'surname'))}
            ${pick('company', 'Company', guess('companyname', 'company', 'organization'))}
          </div>
          <div class="row">
            ${pick('job_title', 'Job title', guess('jobtitle', 'title', 'designation'))}
            ${pick('industry', 'Industry', guess('industry'))}
            ${pick('location', 'Location', guess('location', 'city'))}
          </div>
          <div class="row">
            ${pick('website', 'Website', guess('website'))}
            ${pick('linkedin', 'LinkedIn', guess('linkedin'))}
            ${pick('history', 'Earlier outcome', guess('history', 'leadstatus', 'status'))}
            ${pick('verified_on', 'Verified on', guess('verifiedon', 'verified'))}
          </div>`;
        document.querySelector('[data-action="dialog-confirm"]').disabled = false;
      },
      error: () => toast('That file could not be read as CSV.', true),
    });
  });
}

/* ------------------------------------------------------- do not contact */
async function viewBlocklist() {
  const rows = await api('/blocklist');
  shell(`
    <div class="head"><div><h1>Do not contact</h1>
      <p class="sub">Addresses here are never mailed by any campaign. Anyone who asks to stop,
      or whose address hard-bounces, is added automatically. Add a whole domain by writing
      <span class="mono">@company.com</span>.</p></div>
      <button class="primary" data-action="add-block">Add addresses</button></div>
    <div class="panel">${rows.length ? `
      <table><thead><tr><th>Address</th><th>Reason</th><th>Added</th><th class="num"></th></tr></thead>
      <tbody>${rows.map((b) => `<tr>
        <td class="mono">${esc(b.value)}</td>
        <td class="hint">${esc(b.reason || '')}</td>
        <td class="hint">${when(b.created_at)}</td>
        <td class="num"><button class="small" data-action="unblock" data-id="${b.id}">Remove</button></td>
      </tr>`).join('')}</tbody></table>`
    : '<div class="empty">Nothing blocked yet.</div>'}</div>`, 'blocklist');
}

/* -------------------------------------------------------------- dialog -- */
function openDialog({ title, body, confirm = 'Save', onConfirm, wide, confirmDisabled }) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `
    <div class="dialog ${wide ? 'wide' : ''}">
      <header><h2>${esc(title)}</h2><button class="small" data-action="dialog-close">Close</button></header>
      <div class="body">${body}</div>
      <footer>
        <button data-action="dialog-close">Cancel</button>
        <button class="primary" data-action="dialog-confirm" ${confirmDisabled ? 'disabled' : ''}>${esc(confirm)}</button>
      </footer>
    </div>`;
  document.body.appendChild(scrim);
  scrim.__onConfirm = onConfirm;
  scrim.addEventListener('click', (e) => { if (e.target === scrim) scrim.remove(); });
}

function closeDialog() { document.querySelector('.scrim')?.remove(); }

/* -------------------------------------------------------------- events -- */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, tab, kind } = el.dataset;
  const cid = state.data.campaign?.id;

  try {
    switch (action) {
      case 'login': e.preventDefault(); return doLogin();
      case 'logout':
        e.preventDefault();
        await api('/auth/logout', { method: 'POST' });
        return renderLogin();

      case 'dialog-close': return closeDialog();
      case 'dialog-confirm': {
        const scrim = el.closest('.scrim');
        el.disabled = true;
        try { await scrim.__onConfirm(); closeDialog(); }
        catch (err) { toast(err.message, true); el.disabled = false; }
        return;
      }

      case 'resolve-issue':
        await api(`/stats/issues/${id}/resolve`, { method: 'POST' });
        return viewDashboard();
      case 'sync-inbox':
        await api('/inbox/sync', { method: 'POST' });
        return toast('Checking every mailbox — replies appear in a moment.');

      case 'connect-gmail': {
        const { url } = await api('/mailboxes/gmail/start');
        location.href = url;
        return;
      }
      case 'add-mailbox': return addMailbox(null);
      case 'bulk-mailbox': return bulkMailboxDialog();
      case 'edit-mailbox': {
        const all = await api('/mailboxes');
        return addMailbox(all.find((m) => m.id === +id));
      }
      case 'test-mailbox': {
        const r = await api(`/mailboxes/${id}/test`, { method: 'POST' });
        toast(r.ok ? 'Login works.' : r.error, !r.ok);
        return viewMailboxes();
      }
      case 'revive-mailbox':
        await api(`/mailboxes/${id}`, { method: 'PUT', body: { status: 'active' } });
        return viewMailboxes();

      case 'new-campaign': return newCampaign();
      case 'open-campaign':
        if (e.target.closest('button[data-action^="pause"], button[data-action^="start"]')) return;
        location.hash = `#/campaign/${id}`;
        return;
      case 'start-campaign':
        e.stopPropagation();
        await api(`/campaigns/${id}/status`, { method: 'POST', body: { status: 'active' } });
        toast('Campaign started.');
        return route();
      case 'pause-campaign':
        e.stopPropagation();
        await api(`/campaigns/${id}/status`, { method: 'POST', body: { status: 'paused' } });
        toast('Campaign paused.');
        return route();
      case 'delete-campaign':
        if (!window.confirm('Delete this campaign with all its leads and history?')) return;
        await api(`/campaigns/${id}`, { method: 'DELETE' });
        location.hash = '#/campaigns';
        return;

      case 'tab':
        state.tab = tab;
        return viewCampaign(cid);

      case 'save-steps': {
        const steps = state.data.campaign.steps.map((s) => {
          const get = (key) => document.querySelector(`[data-step="${s.step_no}"][data-key="${key}"]`);
          return {
            step_no: s.step_no,
            day_offset: get('day_offset') ? +get('day_offset').value : s.day_offset,
            subject: get('subject') ? get('subject').value : s.subject,
            body: get('body').value,
            same_thread: get('same_thread') ? get('same_thread').value === 'true' : s.same_thread,
          };
        });
        await api(`/campaigns/${cid}/steps`, { method: 'PUT', body: { steps } });
        toast('Sequence saved.');
        return viewCampaign(cid);
      }

      case 'preview-steps': {
        const p = await api(`/campaigns/${cid}/preview`, { method: 'POST' });
        return openDialog({
          title: `What ${p.lead_used} will receive`,
          wide: true,
          confirm: 'Close',
          onConfirm: async () => {},
          body: p.previews.map((v) => `
            <div class="panel"><header><h3>${v.step_no === 1 ? 'First mail' : `Follow-up ${v.step_no - 1}`}</h3></header>
              <div class="body">
                <div class="hint" style="margin-bottom:8px">Subject: <b>${esc(v.subject)}</b></div>
                <pre style="white-space:pre-wrap;font-family:var(--sans);margin:0">${esc(v.body)}</pre>
              </div></div>`).join(''),
        });
      }

      case 'save-settings': {
        const days = [...document.querySelectorAll('[data-day]:checked')].map((i) => +i.value);
        const mbs = [...document.querySelectorAll('[data-mb]:checked')].map((i) => +i.value);
        await api(`/campaigns/${cid}`, {
          method: 'PUT',
          body: {
            send_days: days,
            window_start: document.getElementById('s_from').value,
            window_end: document.getElementById('s_to').value,
            timezone: document.getElementById('s_tz').value,
            daily_limit: document.getElementById('s_limit').value,
            gap_min_sec: document.getElementById('s_gapmin').value,
            gap_max_sec: document.getElementById('s_gapmax').value,
            bounce_guard: document.getElementById('s_bounce').value,
            mailbox_ids: mbs,
          },
        });
        toast('Settings saved.');
        return viewCampaign(cid);
      }

      case 'import-leads': return importLeadsDialog(cid);
      case 'assign-from-db':
        state.filter = {};
        location.hash = '#/contacts';
        return;

      case 'apply-filter': readFilter(); return viewContacts();
      case 'clear-filter': state.filter = {}; return viewContacts();
      case 'assign-contacts': return assignDialog();
      case 'import-contacts': return importContactsDialog();
      case 'stop-lead':
        await api(`/leads/${id}/stop`, { method: 'POST' });
        toast('Added to do-not-contact.');
        return route();

      case 'inbox-filter':
        state.inboxKind = kind;
        state.selectedLead = null;
        return viewInbox();
      case 'open-thread':
        if (location.hash.startsWith('#/inbox')) return openThread(id);
        state.selectedLead = Number(id);
        location.hash = '#/inbox';
        return;
      case 'send-reply': {
        const text = document.getElementById('replytext').value;
        await api(`/inbox/thread/${id}/reply`, { method: 'POST', body: { text } });
        toast('Reply sent.');
        return openThread(id);
      }

      case 'add-block':
        return openDialog({
          title: 'Never contact these',
          body: `<label class="field"><span>Addresses or domains</span>
            <textarea id="bl_values" class="mono"
              placeholder="someone@company.com&#10;@bigclient.com"></textarea>
            <small>One per line. Start with @ to block a whole domain.</small></label>`,
          confirm: 'Add',
          onConfirm: async () => {
            await api('/blocklist', {
              method: 'POST',
              body: { values: document.getElementById('bl_values').value },
            });
            viewBlocklist();
          },
        });
      case 'unblock':
        await api(`/blocklist/${id}`, { method: 'DELETE' });
        return viewBlocklist();

      default: break;
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// day-picker toggles
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-day]')) e.target.closest('label').classList.toggle('on', e.target.checked);
  if (e.target.matches('[data-hist]')) e.target.closest('label').classList.toggle('on', e.target.checked);
});

/* -------------------------------------------------------------- router -- */
async function route() {
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  state.route = hash;

  try {
    const me = await api('/auth/me');
    if (!me.authenticated) return renderLogin();

    if (hash.startsWith('campaign/')) {
      await viewCampaign(hash.split('/')[1]);
      if (state.tab === 'settings') paintSettingsMailboxes(state.data.campaign);
      return;
    }
    if (hash === 'campaigns') { state.tab = 'sequence'; return viewCampaigns(); }
    if (hash === 'contacts') return viewContacts();
    if (hash === 'mailboxes') return viewMailboxes();
    if (hash === 'inbox') return viewInbox();
    if (hash === 'blocklist') return viewBlocklist();
    return viewDashboard();
  } catch (err) {
    if (err.message !== 'Not signed in.') toast(err.message, true);
  }
}

window.addEventListener('hashchange', route);
route();
setInterval(() => {
  if (['', 'inbox'].includes(state.route) && !document.querySelector('.scrim')) route();
}, 60000);
