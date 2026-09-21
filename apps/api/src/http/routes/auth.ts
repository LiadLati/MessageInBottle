import { Hono } from 'hono';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  ResetPasswordRequestSchema,
  TimeZoneRequestSchema,
  normalizeEmail,
  normalizeUsername,
} from '@mib/shared';
import { conflict, tooManyRequests } from '../../lib/errors.js';
import { RateLimiter, type RateLimitRule } from '../../lib/rate-limit.js';
import {
  emailTaken,
  login,
  logout,
  register,
  requestPasswordReset,
  resetPassword,
  setAccountTimeZone,
  usernameTaken,
} from '../../services/auth.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { jsonBody } from '../validate.js';

// Attempt budgets per client address and, for sign-in, per target account. Both are counted
// before the credentials are checked so guessing costs the same whether or not it succeeds.
export const LOGIN_PER_ADDRESS: RateLimitRule = { limit: 20, windowMs: 15 * 60 * 1000 };
export const LOGIN_PER_ACCOUNT: RateLimitRule = { limit: 10, windowMs: 15 * 60 * 1000 };
export const REGISTER_PER_ADDRESS: RateLimitRule = { limit: 10, windowMs: 60 * 60 * 1000 };
export const FORGOT_PER_ADDRESS: RateLimitRule = { limit: 5, windowMs: 15 * 60 * 1000 };
export const FORGOT_PER_EMAIL: RateLimitRule = { limit: 3, windowMs: 60 * 60 * 1000 };
export const RESET_PER_ADDRESS: RateLimitRule = { limit: 10, windowMs: 15 * 60 * 1000 };

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
    if (!d.allowed) throw tooManyRequests(d.retryAfterMs);
  };

  r.post('/register', jsonBody(RegisterRequestSchema), (c) => {
    enforce(`register:${clientKey(c)}`, REGISTER_PER_ADDRESS);
    const body = c.req.valid('json');
    const ctx = c.get('ctx');
    if (usernameTaken(ctx, body.username))
      throw conflict('username_taken', 'that username is already taken');
    if (emailTaken(ctx, body.email))
      throw conflict('email_taken', 'that email is already registered');
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

  // Same answer whether or not the address is known: the response cannot be used to enumerate.
  r.post('/password/forgot', jsonBody(ForgotPasswordRequestSchema), async (c) => {
    const { email } = c.req.valid('json');
    enforce(`forgot:addr:${clientKey(c)}`, FORGOT_PER_ADDRESS);
    enforce(`forgot:email:${normalizeEmail(email)}`, FORGOT_PER_EMAIL);
    await requestPasswordReset(c.get('ctx'), email);
    return c.json({ ok: true }, 202);
  });

  r.post('/password/reset', jsonBody(ResetPasswordRequestSchema), (c) => {
    enforce(`reset:addr:${clientKey(c)}`, RESET_PER_ADDRESS);
    resetPassword(c.get('ctx'), c.req.valid('json'));
    return c.body(null, 204);
  });

  r.get('/me', requireAuth, (c) => c.json(c.get('user')));
  // The device's zone, sent on every start and resume; the account keeps the last one it heard.
  r.put('/time-zone', requireAuth, jsonBody(TimeZoneRequestSchema), (c) =>
    c.json(setAccountTimeZone(c.get('ctx'), c.get('user'), c.req.valid('json').timeZone)),
  );
  r.post('/logout', requireAuth, (c) => {
    logout(c.get('ctx'), c.get('token'));
    return c.body(null, 204);
  });
  return r;
}
