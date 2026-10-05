import express from 'express';
import { q, one, pool } from '../db/index.js';

export const contactRouter = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROLE_PREFIX = /^(info|admin|support|sales|billing|noreply|no-reply|postmaster|webmaster|abuse|contact|help|office|hello|team|careers|hr|jobs)@/i;

// History values that must never be mailed again.
const POISON = ['bounced', 'unsubscribed', 'not_interested'];

// Builds the WHERE clause shared by the list, the count and the assign call,
// so what you see on screen is exactly what gets assigned.
function buildFilter(f, params) {
  const where = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };

  if (f.search) {
    params.push(`%${String(f.search).toLowerCase()}%`);
    const p = `$${params.length}`;
    where.push(`(lower(email) LIKE ${p} OR lower(company) LIKE ${p}
                 OR lower(first_name) LIKE ${p} OR lower(job_title) LIKE ${p})`);
  }
  if (f.industry) add('lower(industry) = ?', String(f.industry).toLowerCase());
  if (f.location) add('lower(location) LIKE ?', `%${String(f.location).toLowerCase()}%`);
  if (f.job_title) add('lower(job_title) LIKE ?', `%${String(f.job_title).toLowerCase()}%`);
  if (f.list_name) add('list_name = ?', f.list_name);

  if (f.history) {
    const vals = String(f.history).split(',').filter(Boolean);
    if (vals.length) add('history = ANY(?)', vals);
  }

  // Safe by default: anything that bounced or asked to stop is out unless
  // the caller deliberately asks for those rows.
  if (!f.include_poison) {
    params.push(POISON);
    where.push(`history <> ALL($${params.length})`);
  }

  // Never offer someone who is on the do-not-contact list.
  where.push(`NOT EXISTS (SELECT 1 FROM blocklist b
                WHERE b.value = lower(contacts.email)
                   OR b.value = '@' || split_part(lower(contacts.email),'@',2))`);

  // Not already sitting in a live campaign — the same person must not get
  // mail from two campaigns at once.
  if (f.exclude_assigned !== 'false') {
    where.push(`NOT EXISTS (SELECT 1 FROM leads l JOIN campaigns c ON c.id = l.campaign_id
                  WHERE l.contact_id = contacts.id
                    AND c.status <> 'done'
                    AND l.status IN ('pending','active'))`);
  }

  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

contactRouter.get('/', async (req, res) => {
  const params = [];
  const clause = buildFilter(req.query, params);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;

  const total = await one(`SELECT COUNT(*)::int AS c FROM contacts ${clause}`, params);
  params.push(limit, offset);
  const rows = await q(
    `SELECT * FROM contacts ${clause} ORDER BY id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params);

  res.json({ rows, matching: total.c });
});

// Values for the filter dropdowns, plus the overall shape of the database.
contactRouter.get('/facets', async (req, res) => {
  const [industries, locations, lists, history, totals] = await Promise.all([
    q(`SELECT industry AS value, COUNT(*)::int AS n FROM contacts
        WHERE industry <> '' GROUP BY 1 ORDER BY n DESC LIMIT 40`),
    q(`SELECT location AS value, COUNT(*)::int AS n FROM contacts
        WHERE location <> '' GROUP BY 1 ORDER BY n DESC LIMIT 40`),
    q(`SELECT list_name AS value, COUNT(*)::int AS n FROM contacts
        WHERE list_name <> '' GROUP BY 1 ORDER BY n DESC LIMIT 30`),
    q(`SELECT history AS value, COUNT(*)::int AS n FROM contacts GROUP BY 1 ORDER BY n DESC`),
    one(`SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE history = 'fresh')::int AS fresh,
                COUNT(*) FILTER (WHERE verified_on IS NOT NULL
                                   AND verified_on > CURRENT_DATE - 90)::int AS recently_verified
           FROM contacts`),
  ]);
  res.json({ industries, locations, lists, history, ...totals });
});

// Bulk import. Rows arrive already mapped from the browser.
contactRouter.post('/import', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const listName = String(req.body?.list_name || '').slice(0, 120);
  const skipRole = req.body?.skip_role_addresses !== false;

  const report = { added: 0, updated: 0, invalid: 0, role: 0, blocklisted: 0 };
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    for (const raw of rows) {
      const email = String(raw.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) { report.invalid++; continue; }
      if (skipRole && ROLE_PREFIX.test(email)) { report.role++; continue; }

      const history = normaliseHistory(raw.history);

      const fields = {};
      const known = ['email', 'first_name', 'last_name', 'company', 'job_title', 'industry',
        'location', 'website', 'linkedin', 'company_domain', 'history',
        'last_contacted_at', 'prev_opens', 'prev_replies', 'verified_on'];
      for (const [k, v] of Object.entries(raw)) {
        if (known.includes(k)) continue;
        if (v != null && String(v).trim() !== '') fields[k] = String(v).trim().slice(0, 500);
      }

      const r = await client.query(
        `INSERT INTO contacts (email, first_name, last_name, company, job_title, industry,
                               location, website, linkedin, company_domain, fields, list_name,
                               history, last_contacted_at, prev_opens, prev_replies, verified_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (email) DO UPDATE SET
           first_name = COALESCE(NULLIF(EXCLUDED.first_name,''), contacts.first_name),
           last_name  = COALESCE(NULLIF(EXCLUDED.last_name,''),  contacts.last_name),
           company    = COALESCE(NULLIF(EXCLUDED.company,''),    contacts.company),
           job_title  = COALESCE(NULLIF(EXCLUDED.job_title,''),  contacts.job_title),
           industry   = COALESCE(NULLIF(EXCLUDED.industry,''),   contacts.industry),
           location   = COALESCE(NULLIF(EXCLUDED.location,''),   contacts.location),
           website    = COALESCE(NULLIF(EXCLUDED.website,''),    contacts.website),
           linkedin   = COALESCE(NULLIF(EXCLUDED.linkedin,''),   contacts.linkedin),
           fields     = contacts.fields || EXCLUDED.fields,
           -- a worse outcome always wins, so a bounce can never be downgraded
           history    = CASE WHEN contacts.history = ANY($18) THEN contacts.history
                             ELSE EXCLUDED.history END,
           prev_opens   = GREATEST(contacts.prev_opens, EXCLUDED.prev_opens),
           prev_replies = GREATEST(contacts.prev_replies, EXCLUDED.prev_replies)
         RETURNING (xmax = 0) AS inserted`,
        [email, raw.first_name || '', raw.last_name || '', raw.company || '',
          raw.job_title || '', raw.industry || '', raw.location || '', raw.website || '',
          raw.linkedin || '', raw.company_domain || '', JSON.stringify(fields), listName,
          history, raw.last_contacted_at || null,
          parseInt(raw.prev_opens, 10) || 0, parseInt(raw.prev_replies, 10) || 0,
          raw.verified_on || null, POISON],
      );
      if (r.rows[0]?.inserted) report.added++; else report.updated++;

      // Anything already dead goes straight onto the do-not-contact list.
      if (POISON.includes(history)) {
        await client.query(
          `INSERT INTO blocklist (value, reason) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [email, history === 'bounced' ? 'Bounced in earlier sending' : 'Asked to stop earlier']);
        report.blocklisted++;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.json(report);
});

// Order matters here. "Not yet contacted" contains "contacted", and
// "opened but no reply" contains "reply" — the negative forms have to be
// caught before the words they happen to contain.
function normaliseHistory(v) {
  const s = String(v || '').toLowerCase().trim();
  if (!s) return 'fresh';

  if (/bounce|hard.?fail|invalid/.test(s)) return 'bounced';
  if (/unsub|opted?.?out|do.?not.?contact/.test(s)) return 'unsubscribed';
  if (/not.?interested|wrong.?person|no.?thanks/.test(s)) return 'not_interested';

  if (/not.?yet.?contacted|never.?contacted|not.?contacted/.test(s)) return 'fresh';
  if (/interested/.test(s)) return 'interested';
  if (/no.?repl|without.?repl|not.?replied/.test(s)) return 'opened';

  if (/repl/.test(s)) return 'replied';
  if (/open/.test(s)) return 'opened';
  if (/contact|sent|delivered/.test(s)) return 'contacted';
  return 'fresh';
}

// The whole point of the database: take what the filter matched and drop it
// into a campaign.
contactRouter.post('/assign', async (req, res) => {
  const campaignId = req.body?.campaign_id;
  const count = Math.min(parseInt(req.body?.count, 10) || 0, 50000);
  const ids = Array.isArray(req.body?.contact_ids) ? req.body.contact_ids : null;

  if (!campaignId) return res.status(400).json({ error: 'Pick a campaign first.' });
  const campaign = await one('SELECT * FROM campaigns WHERE id=$1', [campaignId]);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

  let picked;
  if (ids && ids.length) {
    picked = await q('SELECT * FROM contacts WHERE id = ANY($1)', [ids]);
  } else {
    const params = [];
    const clause = buildFilter(req.body?.filter || {}, params);
    if (!count) return res.status(400).json({ error: 'Say how many contacts to assign.' });
    params.push(count);
    picked = await q(
      `SELECT * FROM contacts ${clause} ORDER BY
         CASE history WHEN 'fresh' THEN 0 WHEN 'opened' THEN 1 ELSE 2 END, id
       LIMIT $${params.length}`, params);
  }

  let assigned = 0;
  let skipped = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of picked) {
      if (POISON.includes(c.history)) { skipped++; continue; }
      const r = await client.query(
        `INSERT INTO leads (campaign_id, contact_id, email, first_name, last_name, company, fields)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (campaign_id, email) DO NOTHING
         RETURNING id`,
        [campaignId, c.id, c.email, c.first_name, c.last_name, c.company,
          JSON.stringify({
            ...c.fields,
            job_title: c.job_title,
            industry: c.industry,
            location: c.location,
            website: c.website,
            linkedin: c.linkedin,
          })],
      );
      if (r.rowCount) assigned++; else skipped++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.json({ assigned, skipped, campaign: campaign.name });
});

// How long a campaign's queue will last at its current speed.
contactRouter.get('/runway/:campaignId', async (req, res) => {
  const c = await one('SELECT * FROM campaigns WHERE id=$1', [req.params.campaignId]);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });

  const steps = await one(
    'SELECT COUNT(*)::int AS n FROM sequence_steps WHERE campaign_id=$1', [c.id]);
  const open = await one(
    `SELECT COUNT(*)::int AS n FROM leads
      WHERE campaign_id=$1 AND status IN ('pending','active')`, [c.id]);

  // Not everyone gets every step — replies stop the sequence early.
  const sendsPerLead = Math.max(1, steps.n * 0.85);
  const totalSends = open.n * sendsPerLead;
  const days = c.daily_limit ? Math.ceil(totalSends / c.daily_limit) : 0;

  res.json({
    open_leads: open.n,
    steps: steps.n,
    daily_limit: c.daily_limit,
    estimated_sends: Math.round(totalSends),
    working_days: days,
    weeks: +(days / 5).toFixed(1),
  });
});

contactRouter.delete('/:id', async (req, res) => {
  await q('DELETE FROM contacts WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});
