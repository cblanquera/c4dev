/**
 * Encrypting card secrets at rest. Values are sealed with AES-256-GCM under a
 * key kept beside the database (`secret.key`, mode 600), or given as
 * FACTORY_SECRET_KEY (32 bytes, base64), so a copied database alone reveals
 * nothing. Without the key, sealed secrets can't be read back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const KEY_FILE = 'secret.key';
const PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The key from FACTORY_SECRET_KEY, or `dir/secret.key`, created on first use. */
export function loadKey(dir: string): Buffer {
  const fromEnv = process.env.FACTORY_SECRET_KEY;
  if (fromEnv) return checked(Buffer.from(fromEnv, 'base64'), 'FACTORY_SECRET_KEY');
  const file = path.join(dir, KEY_FILE);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(file, randomBytes(32).toString('base64'), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return checked(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64'), file);
}

function checked(key: Buffer, where: string): Buffer {
  if (key.length !== 32) throw new Error(`${where} must hold a 32-byte key in base64`);
  return key;
}

export const isSealed = (value: string) => value.startsWith(PREFIX);

export function seal(key: Buffer, text: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

/** Opens a sealed value; anything unsealed (from before encryption) is returned as it is. */
export function unseal(key: Buffer, value: string): string {
  if (!isSealed(value)) return value;
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(`Can't decrypt a stored secret: the key (${KEY_FILE} or FACTORY_SECRET_KEY) isn't the one it was saved with`);
  }
}
