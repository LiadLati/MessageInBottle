import { Hono } from 'hono';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { LoginRequestSchema, RegisterRequestSchema, normalizeUsername } from '@mib/shared';
import { AppError, conflict } from '../../lib/errors.js';
import { RateLimiter, type RateLimitRule } from '../../lib/rate-limit.js';
import { login, logout, register, usernameTaken } from '../../services/auth.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { jsonBody } from '../validate.js';

// Attempt budgets per client address and, for sign-in, per target account. Both are counted
// before the credentials are checked so guessing costs the same whether or not it succeeds.
export const LOGIN_PER_ADDRESS: RateLimitRule = { limit: 20, windowMs: 15 * 60 * 1000 };
export const LOGIN_PER_ACCOUNT: RateLimitRule = { limit: 10, windowMs: 15 * 60 * 1000 };
export const REGISTER_PER_ADDRESS: RateLimitRule = { limit: 10, windowMs: 60 * 60 * 1000 };

const rateLimited = (retryAfterMs: number) =>
  new AppError(429, 'rate_limited', 'too many attempts, try again later', {
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  });

export function authRoutes(limiter = new RateLimiter()) {
  const r = new Hono<AppEnv>();

  // The client's network address: the socket peer, or the first X-Forwarded-For entry when the
  // deployment declares a trusted reverse proxy (MIB_TRUST_PROXY). In-process test requests
  // have no socket and share one bucket.
  const clientKey = (c: Context<AppEnv>): string => {
    if (c.get('ctx').config.trustProxy) {
      const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (first) return first;
    }
    try {
      return getConnInfo(c).remote.address ?? 'local';
    } catch {
      return 'local';
    }
  };
  const enforce = (key: string, rule: RateLimitRule) => {
    const d = limiter.hit(key, rule);
    if (!d.allowed) throw rateLimited(d.retryAfterMs);
  };

  r.post('/register', jsonBody(RegisterRequestSchema), (c) => {
    enforce(`register:${clientKey(c)}`, REGISTER_PER_ADDRESS);
    const body = c.req.valid('json');
    const ctx = c.get('ctx');
    if (usernameTaken(ctx, body.username))
      throw conflict('username_taken', 'that username is already taken');
    return c.json(register(ctx, body), 201);
  });

  r.post('/login', jsonBody(LoginRequestSchema), (c) => {
    const body = c.req.valid('json');
    const accountKey = `login:user:${normalizeUsername(body.username)}`;
    enforce(`login:addr:${clientKey(c)}`, LOGIN_PER_ADDRESS);
    enforce(accountKey, LOGIN_PER_ACCOUNT);
    const session = login(c.get('ctx'), body);
    // A successful sign-in clears the account's failed-attempt budget.
    limiter.reset(accountKey);
    return c.json(session, 200);
  });

  r.get('/me', requireAuth, (c) => c.json(c.get('user')));
  r.post('/logout', requireAuth, (c) => {
    logout(c.get('ctx'), c.get('token'));
    return c.body(null, 204);
  });
  return r;
}
