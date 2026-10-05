import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 8,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export async function q(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}

export async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

export async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[db] schema ready');
}
