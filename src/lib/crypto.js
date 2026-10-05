import crypto from 'node:crypto';
import { config } from '../config.js';

const KEY = Buffer.from(config.encryptionKey, 'hex');
if (KEY.length !== 32) {
  console.error('\nENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
  console.error('Generate one with:');
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
  process.exit(1);
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

export function decrypt(payload) {
  const [ivHex, tagHex, dataHex] = String(payload).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}
