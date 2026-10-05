import { config } from './config.js';
import { tick } from './lib/scheduler.js';
import { syncAllMailboxes } from './lib/inbox.js';

let sending = false;
let syncing = false;

export function startWorker() {
  console.log(
    `[worker] sending every ${config.schedulerIntervalMs / 1000}s, ` +
    `inbox every ${config.imapIntervalMs / 60000} min`,
  );

  setInterval(async () => {
    if (sending) return;              // a slow SMTP server must not stack ticks
    sending = true;
    try {
      await tick();
    } catch (err) {
      console.error('[worker] send tick failed:', err.message);
    } finally {
      sending = false;
    }
  }, config.schedulerIntervalMs);

  setInterval(async () => {
    if (syncing) return;
    syncing = true;
    try {
      await syncAllMailboxes();
    } catch (err) {
      console.error('[worker] inbox sync failed:', err.message);
    } finally {
      syncing = false;
    }
  }, config.imapIntervalMs);

  // first inbox check shortly after boot
  setTimeout(() => syncAllMailboxes().catch(() => {}), 20000);
}
