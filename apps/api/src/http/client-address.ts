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
export function clientAddress(c: Context<AppEnv>): string {
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
