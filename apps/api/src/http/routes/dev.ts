import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import {
  DevAdvanceRequestSchema,
  DevArriveRequestSchema,
  DevLoseRequestSchema,
  type DevStatus,
} from '@mib/shared';
import * as t from '../../db/schema.js';
import { plannedArrivalAt } from '../../domain/routing.js';
import { DevClock } from '../../lib/clock.js';
import { OutboxMailer } from '../../lib/mail.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { activePlan, runJourneyTick } from '../../services/journey.js';
import { devLoseBottle } from '../../services/outcomes.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { jsonBody } from '../validate.js';

// Deterministic development controls (spec §19: accelerated test journeys are kept separate).
// Mounted only when MIB_DEV_MODE=true; time only ever moves forward.
export function devRoutes() {
  const r = new Hono<AppEnv>();

  // Registered before the authentication middleware on purpose: password recovery is used while
  // signed out, so the captured message has to be readable then. This router is mounted only
  // when MIB_DEV_MODE is on, and the outbox only ever exists for the development mailer, so no
  // production deployment can reach it.
  r.get('/outbox', (c) => {
    const mailer = c.get('ctx').mailer;
    const messages =
      mailer instanceof OutboxMailer
        ? mailer.messages.map((m) => ({
            id: m.id,
            to: m.to,
            subject: m.subject,
            text: m.text,
            sentAt: new Date(m.sentAt).toISOString(),
          }))
        : [];
    return c.json({ provider: mailer.kind, messages });
  });

  r.use('*', requireAuth);

  const status = (ctx: AppEnv['Variables']['ctx']): DevStatus => ({
    devMode: ctx.config.devMode,
    serverTime: new Date(ctx.clock.now()).toISOString(),
    clockOffsetMs: ctx.clock instanceof DevClock ? ctx.clock.offset() : 0,
    msPerChartUnit: ctx.config.msPerChartUnit,
  });

  r.get('/status', (c) => c.json(status(c.get('ctx'))));

  r.post('/advance', jsonBody(DevAdvanceRequestSchema), (c) => {
    const ctx = c.get('ctx');
    if (!(ctx.clock instanceof DevClock)) throw badRequest('dev_only', 'dev clock is not enabled');
    ctx.clock.advance(c.req.valid('json').ms);
    const tick = runJourneyTick(ctx);
    return c.json({ ...status(ctx), tick });
  });

  // Advances the clock to exactly the planned arrival of one of the caller's bottles and runs
  // the worker, so the recipient's shore receives it through the normal path.
  r.post('/arrive', jsonBody(DevArriveRequestSchema), (c) => {
    const ctx = c.get('ctx');
    if (!(ctx.clock instanceof DevClock)) throw badRequest('dev_only', 'dev clock is not enabled');
    const { bottleId } = c.req.valid('json');
    const bottle = ctx.db.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get();
    if (!bottle || bottle.senderId !== c.get('user').id) throw notFound('bottle');
    if (bottle.state !== 'at_sea') throw badRequest('not_at_sea', 'bottle is not at sea');
    const plan = activePlan(ctx.db, bottleId);
    if (!plan) throw notFound('route plan');
    ctx.clock.advanceTo(plannedArrivalAt(plan));
    const tick = runJourneyTick(ctx);
    return c.json({ ...status(ctx), tick });
  });

  // Ends one of the caller's own journeys now, through the server-owned outcome path. This is
  // the only thing that can lose a bottle until the risk policy (spec D08) is approved.
  r.post('/lose', jsonBody(DevLoseRequestSchema), (c) => {
    const ctx = c.get('ctx');
    const { bottleId, reason } = c.req.valid('json');
    const outcome = devLoseBottle(ctx, c.get('user'), bottleId, reason);
    return c.json({ ...status(ctx), outcome });
  });

  r.post('/tick', (c) => c.json(runJourneyTick(c.get('ctx'))));
  return r;
}
