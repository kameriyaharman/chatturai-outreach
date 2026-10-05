import express from 'express';
import { q, one, pool } from '../db/index.js';

export const leadRouter = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROLE_PREFIX = /^(info|admin|support|sales|billing|noreply|no-reply|postmaster|webmaster|abuse|contact|help|office)@/i;

leadRouter.get('/', async (req, res) => {
  const { campaign_id, status, search, limit = 100, offset = 0 } = req.query;
  const where = [];
  const params = [];

  if (campaign_id) { params.push(campaign_id); where.push(`campaign_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    where.push(`(lower(email) LIKE $${params.length} OR lower(company) LIKE $${params.length}
                 OR lower(first_name) LIKE $${params.length})`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(Math.min(parseInt(limit, 10) || 100, 500));
  params.push(parseInt(offset, 10) || 0);

  const rows = await q(
    `SELECT * FROM leads ${clause} ORDER BY id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const total = await one(
    `SELECT COUNT(*)::int AS c FROM leads ${clause}`, params.slice(0, params.length - 2));

  res.json({ rows, total: total.c });
});

// The CSV is parsed in the browser; this takes the mapped rows.
// Duplicates, role addresses and blocklisted addresses are dropped here.
leadRouter.post('/import', async (req, res) => {
  const campaignId = req.body?.campaign_id;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const skipRole = req.body?.skip_role_addresses !== false;

  if (!campaignId) return res.status(400).json({ error: 'Pick a campaign first.' });

  const campaign = await one('SELECT * FROM campaigns WHERE id=$1', [campaignId]);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

  const report = { added: 0, duplicate: 0, invalid: 0, blocked: 0, role: 0 };
  const seen = new Set();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    for (const raw of rows) {
      const email = String(raw.email || '').trim().toLowerCase();

      if (!EMAIL_RE.test(email)) { report.invalid++; continue; }
      if (seen.has(email)) { report.duplicate++; continue; }
      seen.add(email);
      if (skipRole && ROLE_PREFIX.test(email)) { report.role++; continue; }

      const domain = '@' + email.split('@')[1];
      const blocked = await client.query(
        'SELECT 1 FROM blocklist WHERE value=$1 OR value=$2 LIMIT 1', [email, domain]);
      if (blocked.rowCount) { report.blocked++; continue; }

      // Anything that is not a known column is kept as a custom merge tag.
      const fields = {};
      for (const [k, v] of Object.entries(raw)) {
        if (['email', 'first_name', 'last_name', 'company'].includes(k)) continue;
        if (v != null && String(v).trim() !== '') fields[k] = String(v).trim();
      }

      const ins = await client.query(
        `INSERT INTO leads (campaign_id, email, first_name, last_name, company, fields)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (campaign_id, email) DO NOTHING
         RETURNING id`,
        [campaignId, email, raw.first_name || '', raw.last_name || '',
          raw.company || '', JSON.stringify(fields)],
      );
      if (ins.rowCount) report.added++; else report.duplicate++;
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

leadRouter.post('/:id/stop', async (req, res) => {
  await q(`UPDATE leads SET status='unsubscribed', next_send_at=NULL WHERE id=$1`, [req.params.id]);
  const lead = await one('SELECT email FROM leads WHERE id=$1', [req.params.id]);
  if (lead) {
    await q(`INSERT INTO blocklist (value, reason) VALUES ($1,'Stopped by hand')
             ON CONFLICT DO NOTHING`, [lead.email.toLowerCase()]);
  }
  res.json({ ok: true });
});

leadRouter.delete('/:id', async (req, res) => {
  await q('DELETE FROM leads WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ------------------------------------------------------------- blocklist ---
export const blocklistRouter = express.Router();

blocklistRouter.get('/', async (req, res) => {
  res.json(await q('SELECT * FROM blocklist ORDER BY created_at DESC LIMIT 500'));
});

blocklistRouter.post('/', async (req, res) => {
  const values = String(req.body?.values || '')
    .split(/[\s,;]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
  let added = 0;
  for (const v of values) {
    const r = await q(`INSERT INTO blocklist (value, reason) VALUES ($1,$2)
                       ON CONFLICT DO NOTHING RETURNING id`,
    [v, req.body?.reason || 'Added by hand']);
    if (r.length) added++;
  }
  // stop anything already queued to these addresses
  if (values.length) {
    await q(`UPDATE leads SET status='unsubscribed', next_send_at=NULL
              WHERE lower(email) = ANY($1) AND status IN ('pending','active')`, [values]);
  }
  res.json({ added });
});

blocklistRouter.delete('/:id', async (req, res) => {
  await q('DELETE FROM blocklist WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});
