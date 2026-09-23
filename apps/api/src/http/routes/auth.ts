import { Hono } from 'hono';
import { clientAddress } from '../client-address.js';
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
import { withPolicies } from '../../services/policies.js';
import { jsonBody } from '../validate.js';

// Attempt budgets per client address and, for sign-in, per target account. Both are counted
// before the credentials are checked so guessing costs the same whether or not it succeeds.
export const LOGIN_PER_ADDRESS: RateLimitRule = { limit: 20, windowMs: 15 * 60 * 1000 };
// Failed sign-ins are counted per (account, address) — ten from one address lock only that
// address out of that account — and per account across all addresses, with a much larger
// ceiling that only a distributed attack reaches. A single third party can therefore no longer
// keep an account locked, including a banned account whose only remaining action is to sign
// in and appeal (audit SEC-008). A success clears both.
export const LOGIN_PER_ACCOUNT_ADDRESS: RateLimitRule = { limit: 10, windowMs: 15 * 60 * 1000 };
export const LOGIN_PER_ACCOUNT: RateLimitRule = { limit: 100, windowMs: 15 * 60 * 1000 };

export function signInKeys(username: string, address: string): string[] {
  const account = `login:user:${normalizeUsername(username)}`;
  return [`${account}:addr:${address}`, account];
}

// Counts one credential attempt against an account's budgets (sign-in, and the public account
// deletion form, which checks the same credentials — audit ARCH-009).
export function chargeSignIn(limiter: RateLimiter, username: string, address: string) {
  const [pair, account] = signInKeys(username, address);
  const byPair = limiter.hit(pair!, LOGIN_PER_ACCOUNT_ADDRESS);
  if (!byPair.allowed) return byPair;
  return limiter.hit(account!, LOGIN_PER_ACCOUNT);
}

export function clearSignIn(limiter: RateLimiter, username: string, address: string): void {
  for (const key of signInKeys(username, address)) limiter.reset(key);
}
export const REGISTER_PER_ADDRESS: RateLimitRule = { limit: 10, windowMs: 60 * 60 * 1000 };
export const FORGOT_PER_ADDRESS: RateLimitRule = { limit: 5, windowMs: 15 * 60 * 1000 };
export const FORGOT_PER_EMAIL: RateLimitRule = { limit: 3, windowMs: 60 * 60 * 1000 };
export const ZONE_CHANGES_PER_ACCOUNT: RateLimitRule = { limit: 4, windowMs: 24 * 60 * 60 * 1000 };
export const RESET_PER_ADDRESS: RateLimitRule = { limit: 10, windowMs: 15 * 60 * 1000 };

export function authRoutes(limiter = new RateLimiter()) {
  const r = new Hono<AppEnv>();

  const clientKey = clientAddress;
  const enforce = (key: string, rule: RateLimitRule) => {
    const d = limiter.hit(key, rule);
    if (!d.allowed) throw tooManyRequests(d.retryAfterMs);
  };

  r.post('/register', jsonBody(RegisterRequestSchema), async (c) => {
    enforce(`register:${clientKey(c)}`, REGISTER_PER_ADDRESS);
    const body = c.req.valid('json');
    const ctx = c.get('ctx');
    if (usernameTaken(ctx, body.username))
      throw conflict('username_taken', 'that username is already taken');
    if (emailTaken(ctx, body.email))
      throw conflict('email_taken', 'that email is already registered');
    const session = await register(ctx, body);
    return c.json({ token: session.token, user: withPolicies(ctx, session.user) }, 201);
  });

  r.post('/login', jsonBody(LoginRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const address = clientKey(c);
    enforce(`login:addr:${address}`, LOGIN_PER_ADDRESS);
    const charged = chargeSignIn(limiter, body.username, address);
    if (!charged.allowed) throw tooManyRequests(charged.retryAfterMs);
    const session = await login(c.get('ctx'), body);
    // A successful sign-in clears the account's failed-attempt budgets.
    clearSignIn(limiter, body.username, address);
    return c.json({ token: session.token, user: withPolicies(c.get('ctx'), session.user) }, 200);
  });

  // Same answer whether or not the address is known: the response cannot be used to enumerate.
  r.post('/password/forgot', jsonBody(ForgotPasswordRequestSchema), (c) => {
    const { email } = c.req.valid('json');
    enforce(`forgot:addr:${clientKey(c)}`, FORGOT_PER_ADDRESS);
    enforce(`forgot:email:${normalizeEmail(email)}`, FORGOT_PER_EMAIL);
    // Not awaited: the answer never depends on whether the address is known or whether mail
    // could be delivered. Failures are handled and logged inside.
    void requestPasswordReset(c.get('ctx'), email);
    return c.json({ ok: true }, 202);
  });

  r.post('/password/reset', jsonBody(ResetPasswordRequestSchema), async (c) => {
    enforce(`reset:addr:${clientKey(c)}`, RESET_PER_ADDRESS);
    await resetPassword(c.get('ctx'), c.req.valid('json'));
    return c.body(null, 204);
  });

  r.get('/me', requireAuth, (c) => c.json(withPolicies(c.get('ctx'), c.get('user'))));
  // The device's zone, sent on every start and resume; the account keeps the last one it heard.
  r.put('/time-zone', requireAuth, jsonBody(TimeZoneRequestSchema), (c) => {
    const user = c.get('user');
    const { timeZone } = c.req.valid('json');
    // Each zone change moves the account's nights forward, so rotating zones used to dodge
    // every storm (audit ARCH-010). Real travel changes a zone a few times a day at most;
    // resyncing the same zone is free.
    if (timeZone !== user.timeZone) enforce(`tz:${user.id}`, ZONE_CHANGES_PER_ACCOUNT);
    return c.json(withPolicies(c.get('ctx'), setAccountTimeZone(c.get('ctx'), user, timeZone)));
  });
  r.post('/logout', requireAuth, (c) => {
    logout(c.get('ctx'), c.get('token'));
    return c.body(null, 204);
  });
  return r;
}
