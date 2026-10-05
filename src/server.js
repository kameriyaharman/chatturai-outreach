import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { migrate, pool } from './db/index.js';
import { authRouter, requireAuth } from './routes/auth.js';
import { mailboxRouter } from './routes/mailboxes.js';
import { campaignRouter } from './routes/campaigns.js';
import { leadRouter, blocklistRouter } from './routes/leads.js';
import { contactRouter } from './routes/contacts.js';
import { inboxRouter, statsRouter } from './routes/inbox.js';
import { startWorker } from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/mailboxes', requireAuth, mailboxRouter);
app.use('/api/campaigns', requireAuth, campaignRouter);
app.use('/api/leads', requireAuth, leadRouter);
app.use('/api/contacts', requireAuth, contactRouter);
app.use('/api/blocklist', requireAuth, blocklistRouter);
app.use('/api/inbox', requireAuth, inboxRouter);
app.use('/api/stats', requireAuth, statsRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Errors reach the screen in plain language instead of a blank page.
app.use((err, req, res, _next) => {
  console.error('[api]', err);
  res.status(500).json({ error: err.message || 'Something went wrong.' });
});

const server = app.listen(config.port, async () => {
  console.log(`[web] listening on ${config.port}`);
  try {
    await migrate();
    if (config.runWorker) startWorker();
  } catch (err) {
    console.error('\n[startup] failed.\n');
    // Node tries IPv6 and IPv4 for localhost and wraps both failures in an
    // AggregateError whose own message is empty — dig the real ones out.
    const parts = err?.errors?.length ? err.errors : [err];
    for (const e of parts) {
      console.error('  ' + (e?.message || e?.code || String(e)));
    }
    if (parts.some((e) => e?.code === 'ECONNREFUSED')) {
      console.error(`
  The database is not reachable at the address in DATABASE_URL.

  Running locally with Docker:   docker start ces-pg
  Running locally with Homebrew: brew services start postgresql@16
  On Railway: check that DATABASE_URL is linked to the Postgres service.
`);
    }
    process.exit(1);
  }
});

async function shutdown(signal) {
  console.log(`[app] ${signal} — shutting down`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
