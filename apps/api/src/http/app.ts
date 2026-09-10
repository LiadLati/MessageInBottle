import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import type { AppContext, AuthUser } from '../services/context.js';
import { authRoutes } from './routes/auth.js';
import { bottleRoutes } from './routes/bottles.js';
import { chartRoutes } from './routes/chart.js';
import { devRoutes } from './routes/dev.js';
import { friendRoutes } from './routes/friends.js';
import { notificationRoutes } from './routes/notifications.js';
import { shoreRoutes } from './routes/shore.js';

export type AppEnv = { Variables: { ctx: AppContext; user: AuthUser; token: string } };

export function createApp(ctx: AppContext) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('ctx', ctx);
    await next();
  });
  if (ctx.config.logRequests) app.use('*', logger());
  app.use('/api/*', cors({ origin: ctx.config.corsOrigin, credentials: false }));

  app.get('/api/health', (c) =>
    c.json({ ok: true, serverTime: new Date(ctx.clock.now()).toISOString() }),
  );
  app.route('/api/auth', authRoutes());
  app.route('/api/chart', chartRoutes());
  app.route('/api/friends', friendRoutes());
  app.route('/api/bottles', bottleRoutes());
  app.route('/api/shore', shoreRoutes());
  app.route('/api/notifications', notificationRoutes());
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
      return c.json(
        { error: { code: 'validation', message: 'invalid request', details: err.issues } },
        400,
      );
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
