import { q, one } from '../db/index.js';

// Errors go here in plain language, not into a log file nobody reads.
// The same problem is not raised twice while it is still open.
export async function raiseIssue({ severity = 'warning', title, detail, refType, refId }) {
  const existing = await one(
    `SELECT id FROM issues
      WHERE title = $1 AND resolved = FALSE
        AND created_at > NOW() - interval '24 hours' LIMIT 1`,
    [title],
  );
  if (existing) return existing.id;

  const row = await one(
    `INSERT INTO issues (severity, title, detail, ref_type, ref_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [severity, title, detail || null, refType || null, refId || null],
  );
  console.warn(`[issue] ${severity}: ${title}`);
  return row.id;
}

export async function openIssues() {
  return q('SELECT * FROM issues WHERE resolved = FALSE ORDER BY created_at DESC LIMIT 50');
}
