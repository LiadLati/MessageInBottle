import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { logger } from 'hono/logger';
import type { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import type { AppContext, AuthUser } from '../services/context.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { bottleRoutes } from './routes/bottles.js';
import { chartRoutes } from './routes/chart.js';
import { devRoutes } from './routes/dev.js';
import { friendRoutes } from './routes/friends.js';
import { moderationRoutes } from './routes/moderation.js';
import { notificationRoutes } from './routes/notifications.js';
import { oceanRoutes } from './routes/ocean.js';
import { accountRoutes } from './routes/account.js';
import { supportPage } from './legal-pages.js';
import { legalRoutes } from './routes/legal.js';
import { policyRoutes } from './routes/policies.js';
import { shoreRoutes } from './routes/shore.js';
import { securityHeaders } from './security-headers.js';

export const MAX_REQUEST_BYTES = 64 * 1024;

export type AppEnv = { Variables: { ctx: AppContext; user: AuthUser; token: string } };

export function createApp(ctx: AppContext) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('ctx', ctx);
    await next();
  });
  if (ctx.config.logRequests) app.use('*', logger());
  app.use('*', securityHeaders);
  // No request SeaYou accepts is anywhere near this size (a letter is at most 8 KB); anything
  // larger is refused before it is read, instead of being parsed on the one API thread
  // (audit ARCH-027 / SEC-014).
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_REQUEST_BYTES,
      onError: (c) =>
        c.json({ error: { code: 'payload_too_large', message: 'request body too large' } }, 413),
    }),
  );
  app.use('/api/*', cors({ origin: ctx.config.corsOrigin, credentials: false }));

  // A health check that the database answers, so a load balancer or process manager learns
  // about a dead or locked database file rather than only that Node is alive (ARCH-017).
  app.get('/api/health', (c) => {
    try {
      (ctx.db as unknown as { $client: { prepare(sql: string): { get(): unknown } } }).$client
        .prepare('select 1')
        .get();
    } catch {
      return c.json({ ok: false, error: { code: 'database_unavailable' } }, 503);
    }
    return c.json({
      ok: true,
      serverTime: new Date(ctx.clock.now()).toISOString(),
      // Development builds say how mail is handled, so the password-recovery screen can state
      // plainly that nothing will be delivered. Omitted entirely outside development.
      ...(ctx.config.devMode
        ? {
            devMode: true,
            mail: {
              provider: ctx.config.mail.provider,
              delivers: ctx.config.mail.provider === 'smtp',
            },
          }
        : {}),
    });
  });
  app.route('/api/auth', authRoutes());
  app.route('/api/policies', policyRoutes());
  app.route('/api/account', accountRoutes());
  // Public, unauthenticated HTML. Deliberately not under /api: these are pages, not endpoints.
  app.route('/legal', legalRoutes());
  // The support page: reachable signed out, while a new policy version is waiting to be
  // accepted, while an account is suspended or banned, and while it is being deleted.
  app.get('/support', (c) =>
    c.html(supportPage(c.get('ctx').config.supportEmail), 200, {
      'cache-control': 'public, max-age=300',
    }),
  );
  app.route('/api/chart', chartRoutes());
  app.route('/api/friends', friendRoutes());
  app.route('/api/bottles', bottleRoutes());
  app.route('/api/shore', shoreRoutes());
  app.route('/api/ocean', oceanRoutes());
  app.route('/api/notifications', notificationRoutes());
  app.route('/api/moderation', moderationRoutes());
  app.route('/api/admin', adminRoutes());
  if (ctx.config.devMode) app.route('/api/dev', devRoutes());

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'route not found' } }, 404));
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        err.status as 400,
      );
    }
    if (isZodError(err)) {
      // Path, code and message only: never the rejected input, which may be a password or a
      // letter (ARCH-022; http/validate.ts does the same for the ordinary path).
      const details = err.issues.map((i) => ({ path: i.path, code: i.code, message: i.message }));
      return c.json({ error: { code: 'validation', message: 'invalid request', details } }, 400);
    }
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'unexpected error' } }, 500);
  });
  return app;
}

function isZodError(err: unknown): err is ZodError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'issues' in err &&
    Array.isArray((err as ZodError).issues)
  );
}
