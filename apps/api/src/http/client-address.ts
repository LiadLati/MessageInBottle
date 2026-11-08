import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { AppEnv } from './app.js';

// The address a rate limit is keyed on (audit ARCH-018 / SEC-005).
//
// Without a trusted proxy it is the socket peer. Behind one it comes from X-Forwarded-For, read
// from the RIGHT: each trusted proxy appends the address it received the request from, so with
// H trusted hops the real client is the H-th entry from the end. Anything to the left of that
// was written by the client itself and is ignored — reading the left-most entry, as the code
// once did, let every request choose its own bucket.
//
//   client sends  X-Forwarded-For: 203.0.113.9          (forged)
//   nginx appends                   , 198.51.100.7       (the real peer)
//   H = 1  →  198.51.100.7
//
// A header with fewer entries than trusted hops means the request did not come through the
// proxy chain as configured; the socket peer is used instead. In-process test requests have no
// socket and share one bucket.
//
// The address is then reduced to the unit one subscriber controls (audit SEC-R-007): an IPv4
// address as it is, and an IPv6 address to its /64 network, because a single connection is
// normally handed a whole /64 and could otherwise take a fresh rate-limit bucket for every
// request. An IPv4 address written in IPv6 form (::ffff:a.b.c.d) is treated as the IPv4 one.
export function clientAddress(c: Context<AppEnv>): string {
  return rateLimitKeyOf(rawClientAddress(c));
}

function rawClientAddress(c: Context<AppEnv>): string {
  const { trustProxy, trustedProxyHops } = c.get('ctx').config;
  if (trustProxy) {
    const chain = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const client = chain[chain.length - trustedProxyHops];
    if (client) return client;
  }
  try {
    return getConnInfo(c).remote.address ?? 'local';
  } catch {
    return 'local';
  }
}

export function rateLimitKeyOf(address: string): string {
  const raw = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (mapped) return mapped[1]!;
  if (!raw.includes(':')) return raw;
  const groups = expandIpv6(raw);
  if (!groups) return raw;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

// The eight 16-bit groups of an IPv6 address, lower-case and without leading zeros; null if it
// is not one. An embedded IPv4 tail (…:a.b.c.d) counts as the last two groups.
function expandIpv6(address: string): string[] | null {
  let text = address.toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, cc, d] = v4.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, cc, d].some((n) => n > 255)) return null;
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((cc << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16).toString(16));
}
