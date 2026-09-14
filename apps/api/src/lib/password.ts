import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Password storage: scrypt (RFC 7914) with a per-password random 16-byte salt, encoded as a
// self-describing string so the parameters can be raised later without a migration:
//   scrypt$N=16384,r=8,p=1$<salt hex>$<key hex>
// Plaintext passwords are never stored, returned or logged anywhere in the API.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [algo, params, saltHex, keyHex] = stored.split('$');
  if (algo !== 'scrypt' || !params || !saltHex || !keyHex) return false;
  const opts: Record<string, number> = {};
  for (const part of params.split(',')) {
    const [k, v] = part.split('=');
    if (k && v) opts[k] = Number(v);
  }
  const N = opts.N ?? SCRYPT_N;
  const r = opts.r ?? SCRYPT_R;
  const p = opts.p ?? SCRYPT_P;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Used when the username does not exist so a failed sign-in costs the same time either way.
export const DUMMY_PASSWORD_HASH = hashPassword('not-a-real-password');
