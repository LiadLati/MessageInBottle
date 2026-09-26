import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Password storage: scrypt (RFC 7914) with a per-password random 16-byte salt, encoded as a
// self-describing string so the parameters can be raised without a migration:
//   scrypt$N=65536,r=8,p=1$<salt hex>$<key hex>
// Plaintext passwords are never stored, returned or logged anywhere in the API.
//
// Cost (audit SEC-007): N = 2^16 — 64 MiB and roughly 0.15–0.2 s per derivation — four times the
// Node default the API used to ship. Hashes made with other parameters still verify from the
// parameters they carry, and are re-hashed at the current cost on the next successful sign-in.
//
// Request paths use the asynchronous functions (audit SEC-006): derivation runs on libuv's
// thread pool instead of the one JavaScript thread, and at most MAX_ACTIVE run at once, so a
// burst of sign-in attempts can neither stall every other request nor exhaust memory. When
// more than MAX_WAITING are queued, new ones are refused with PasswordHashingBusyError (503).
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
export const DEFAULT_SCRYPT_N = 2 ** 16;
let scryptN = DEFAULT_SCRYPT_N;

// The test suite hashes thousands of passwords; it runs at Node's old default. Production code
// never calls this.
export function setPasswordHashCost(n: number): number {
  const previous = scryptN;
  scryptN = n;
  return previous;
}

const options = (N: number, r: number, p: number): ScryptOptions => ({
  N,
  r,
  p,
  // Node refuses more than 32 MiB unless told otherwise; allow the configured cost with margin.
  maxmem: 256 * N * r + 1024 * 1024,
});

function encode(salt: Buffer, key: Buffer): string {
  return `scrypt$N=${scryptN},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

interface Parsed {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
}
function parse(stored: string | null | undefined): Parsed | null {
  if (!stored) return null;
  const [algo, params, saltHex, keyHex] = stored.split('$');
  if (algo !== 'scrypt' || !params || !saltHex || !keyHex) return null;
  const opts: Record<string, number> = {};
  for (const part of params.split(',')) {
    const [k, v] = part.split('=');
    if (k && v) opts[k] = Number(v);
  }
  return {
    N: opts.N ?? 16384,
    r: opts.r ?? SCRYPT_R,
    p: opts.p ?? SCRYPT_P,
    salt: Buffer.from(saltHex, 'hex'),
    expected: Buffer.from(keyHex, 'hex'),
  };
}

// ---------- synchronous: startup, seeding and command-line tools only ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH, options(scryptN, SCRYPT_R, SCRYPT_P));
  return encode(salt, key);
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  const s = parse(stored);
  if (!s) return false;
  const actual = scryptSync(password, s.salt, s.expected.length, options(s.N, s.r, s.p));
  return actual.length === s.expected.length && timingSafeEqual(actual, s.expected);
}

// ---------- asynchronous and bounded: every request path ----------

export class PasswordHashingBusyError extends Error {
  override readonly name = 'PasswordHashingBusyError';
}

const MAX_ACTIVE = 2;
const MAX_WAITING = 64;
let active = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_ACTIVE) {
    if (waiting.length >= MAX_WAITING)
      throw new PasswordHashingBusyError('password hashing is busy');
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else active++;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

function derive(
  password: string,
  salt: Buffer,
  length: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, length, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export function hashPasswordAsync(password: string): Promise<string> {
  return withSlot(async () => {
    const salt = randomBytes(16);
    return encode(
      salt,
      await derive(password, salt, KEY_LENGTH, options(scryptN, SCRYPT_R, SCRYPT_P)),
    );
  });
}

export async function verifyPasswordAsync(
  password: string,
  stored: string | null | undefined,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const s = parse(stored);
  if (!s) return { ok: false, needsRehash: false };
  const actual = await withSlot(() =>
    derive(password, s.salt, s.expected.length, options(s.N, s.r, s.p)),
  );
  const ok = actual.length === s.expected.length && timingSafeEqual(actual, s.expected);
  return { ok, needsRehash: ok && (s.N !== scryptN || s.r !== SCRYPT_R || s.p !== SCRYPT_P) };
}

// Used when the username does not exist so a failed sign-in costs the same time either way.
// Computed lazily, at the cost in force when it is first needed.
let dummy: { n: number; hash: string } | null = null;
export function dummyPasswordHash(): string {
  if (!dummy || dummy.n !== scryptN)
    dummy = { n: scryptN, hash: hashPassword('not-a-real-password') };
  return dummy.hash;
}
