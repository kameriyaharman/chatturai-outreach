-- ============================================================
--  Chatturai Outreach — schema
--  Safe to run repeatedly (everything is IF NOT EXISTS).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- MAILBOXES — the sender email IDs created on BigRock
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mailboxes (
  id                SERIAL PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  signature         TEXT DEFAULT '',

  smtp_host         TEXT,
  smtp_port         INTEGER NOT NULL DEFAULT 465,
  smtp_secure       BOOLEAN NOT NULL DEFAULT TRUE,
  imap_host         TEXT,
  imap_port         INTEGER NOT NULL DEFAULT 993,
  imap_secure       BOOLEAN NOT NULL DEFAULT TRUE,
  username          TEXT NOT NULL,
  password_enc      TEXT NOT NULL DEFAULT '', -- AES-256-GCM, never plaintext

  -- 'smtp'  = username + password over SMTP/IMAP
  -- 'gmail' = Google OAuth over HTTPS; works where SMTP ports are blocked
  auth_type         TEXT NOT NULL DEFAULT 'smtp',
  oauth_refresh_enc TEXT,                     -- encrypted Google refresh token

  daily_limit       INTEGER NOT NULL DEFAULT 35,
  warmup_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  warmup_started_on DATE,                     -- ramp is calculated from this

  status            TEXT NOT NULL DEFAULT 'active',   -- active | paused | error
  last_error        TEXT,
  consecutive_fails INTEGER NOT NULL DEFAULT 0,

  sent_today        INTEGER NOT NULL DEFAULT 0,
  quota_date        DATE,
  last_used_at      TIMESTAMPTZ,
  last_imap_sync_at TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- CAMPAIGNS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft',    -- draft | active | paused | done
  timezone       TEXT NOT NULL DEFAULT 'Asia/Kolkata',

  -- 1 = Monday ... 7 = Sunday  (Luxon weekday numbering)
  send_days      INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5}',
  window_start   TIME NOT NULL DEFAULT '10:00',
  window_end     TIME NOT NULL DEFAULT '18:00',

  daily_limit    INTEGER NOT NULL DEFAULT 200,     -- per campaign, per day
  gap_min_sec    INTEGER NOT NULL DEFAULT 45,
  gap_max_sec    INTEGER NOT NULL DEFAULT 150,

  bounce_guard   NUMERIC NOT NULL DEFAULT 5.0,     -- pause above this bounce %
  next_dispatch_at TIMESTAMPTZ,
  sent_today     INTEGER NOT NULL DEFAULT 0,
  quota_date     DATE,

  paused_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- which mailboxes a campaign is allowed to send from
CREATE TABLE IF NOT EXISTS campaign_mailboxes (
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  mailbox_id   INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, mailbox_id)
);

-- ------------------------------------------------------------
-- SEQUENCE — the first mail + follow-ups for a campaign
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sequence_steps (
  id           SERIAL PRIMARY KEY,
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_no      INTEGER NOT NULL,          -- 1 = first mail
  day_offset   INTEGER NOT NULL,          -- days after the previous step
  subject      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  same_thread  BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (campaign_id, step_no)
);

-- ------------------------------------------------------------
-- CONTACTS — the master database. Upload once, assign to
-- campaigns whenever you need them. One row per person.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  first_name     TEXT DEFAULT '',
  last_name      TEXT DEFAULT '',
  company        TEXT DEFAULT '',
  job_title      TEXT DEFAULT '',
  industry       TEXT DEFAULT '',
  location       TEXT DEFAULT '',
  website        TEXT DEFAULT '',
  linkedin       TEXT DEFAULT '',
  company_domain TEXT DEFAULT '',
  fields         JSONB NOT NULL DEFAULT '{}',

  list_name      TEXT DEFAULT '',        -- which upload it came from

  -- what happened in earlier sending, so the same mistake is not repeated
  history        TEXT DEFAULT 'fresh',
  -- fresh | contacted | opened | replied | interested | bounced | unsubscribed | not_interested
  last_contacted_at TIMESTAMPTZ,
  prev_opens     INTEGER NOT NULL DEFAULT 0,
  prev_replies   INTEGER NOT NULL DEFAULT 0,

  verified_on    DATE,                   -- when this address was last verified
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_history  ON contacts (history);
CREATE INDEX IF NOT EXISTS idx_contacts_industry ON contacts (industry);
CREATE INDEX IF NOT EXISTS idx_contacts_location ON contacts (location);
CREATE INDEX IF NOT EXISTS idx_contacts_list     ON contacts (list_name);

-- ------------------------------------------------------------
-- LEADS — a contact placed into one campaign
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id            SERIAL PRIMARY KEY,
  campaign_id   INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id    INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  email         TEXT NOT NULL,
  first_name    TEXT DEFAULT '',
  last_name     TEXT DEFAULT '',
  company       TEXT DEFAULT '',
  fields        JSONB NOT NULL DEFAULT '{}',   -- any extra CSV columns

  status        TEXT NOT NULL DEFAULT 'pending',
  -- pending | active | replied | bounced | unsubscribed | finished | failed

  current_step  INTEGER NOT NULL DEFAULT 0,
  next_send_at  TIMESTAMPTZ DEFAULT NOW(),
  mailbox_id    INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,

  thread_subject    TEXT,
  thread_message_id TEXT,     -- Message-ID of the very first mail
  last_message_id   TEXT,     -- Message-ID of the most recent mail we sent
  thread_references TEXT,
  provider_thread_id TEXT,    -- Gmail threadId, so follow-ups stay on the thread

  replied_at    TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, email)
);

-- Existing installs: add newer columns before anything indexes or reads them.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS provider_thread_id TEXT;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS auth_type TEXT NOT NULL DEFAULT 'smtp';
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS oauth_refresh_enc TEXT;
ALTER TABLE mailboxes ALTER COLUMN password_enc SET DEFAULT '';
ALTER TABLE mailboxes ALTER COLUMN smtp_host DROP NOT NULL;
ALTER TABLE mailboxes ALTER COLUMN imap_host DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_due
  ON leads (campaign_id, status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (email);
CREATE INDEX IF NOT EXISTS idx_leads_contact ON leads (contact_id);

-- ------------------------------------------------------------
-- MESSAGES — every mail sent and received (this is the inbox)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id            SERIAL PRIMARY KEY,
  lead_id       INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id   INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  mailbox_id    INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,

  direction     TEXT NOT NULL,             -- out | in
  step_no       INTEGER,
  from_addr     TEXT,
  to_addr       TEXT,
  subject       TEXT,
  body          TEXT,

  message_id    TEXT,
  in_reply_to   TEXT,
  kind          TEXT DEFAULT 'normal',     -- normal | bounce | auto_reply | unsubscribe
  is_read       BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages (message_id);
CREATE INDEX IF NOT EXISTS idx_messages_lead  ON messages (lead_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages (direction, sent_at DESC);

-- ------------------------------------------------------------
-- BLOCKLIST — never mail these again, in any campaign
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blocklist (
  id          SERIAL PRIMARY KEY,
  value       TEXT NOT NULL UNIQUE,   -- full email, or "@domain.com"
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- ISSUES — anything that needs a human, in plain language
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issues (
  id          SERIAL PRIMARY KEY,
  severity    TEXT NOT NULL DEFAULT 'warning',  -- info | warning | critical
  title       TEXT NOT NULL,
  detail      TEXT,
  ref_type    TEXT,
  ref_id      INTEGER,
  resolved    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- IMAP sync bookmarks
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imap_state (
  mailbox_id   INTEGER PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  uid_validity BIGINT,
  last_uid     BIGINT NOT NULL DEFAULT 0
);
