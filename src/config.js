import dotenv from 'dotenv';
dotenv.config();

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`\nMissing environment variable: ${name}`);
    console.error('Set it in Railway → your service → Variables, then redeploy.\n');
    process.exit(1);
  }
  return v;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: required('DATABASE_URL'),

  // 64 hex characters. Generate once with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  encryptionKey: required('ENCRYPTION_KEY'),

  // the password you type to open the app
  appPassword: required('APP_PASSWORD'),
  jwtSecret: process.env.JWT_SECRET || required('ENCRYPTION_KEY'),

  // set to "false" on a second Railway service if you ever split web and worker
  runWorker: (process.env.RUN_WORKER || 'true') !== 'false',

  // Public URL of this app — Google redirects back here after consent.
  appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',

  // Who may sign in with Google. Empty means: anyone already set up as a
  // mailbox, plus the very first account when there are none yet.
  allowedLoginEmails: (process.env.ALLOWED_LOGIN_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  // One callback serves both signing in and connecting another mailbox, so
  // only a single redirect URI has to be registered with Google.
  get googleRedirectUri() {
    return `${this.appUrl}/api/auth/google/callback`;
  },

  schedulerIntervalMs: parseInt(process.env.SCHEDULER_INTERVAL_MS || '30000', 10),
  imapIntervalMs: parseInt(process.env.IMAP_INTERVAL_MS || '300000', 10),
  maxSendsPerTick: parseInt(process.env.MAX_SENDS_PER_TICK || '12', 10),
};
