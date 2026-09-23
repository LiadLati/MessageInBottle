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
import { requireDeveloper, requireGoodStanding } from '../middleware/admin.js';
import { jsonBody } from '../validate.js';

// Deterministic development controls (spec §19: accelerated test journeys are kept separate).
//
// Three layers keep these away from real accounts and real data:
//   • the router is mounted only when MIB_DEV_MODE is explicitly `true`, which the configuration
//     refuses in production — so a production server has no /api/dev routes at all (404);
//   • every route behind it, the outbox included, requires a signed-in account with the
//     `developer` role *and* dev mode (requireDeveloper), so an anonymous caller gets 401, a
//     member or an administrator 403, and a developer gets 403 on /api/admin;
//   • each control still only ever touches the caller's own bottles, and time only ever moves
//     forward.
export function devRoutes() {
  const r = new Hono<AppEnv>();

  r.use('*', requireAuth, requireDeveloper, requireGoodStanding);

  // The captured mail holds live password-reset links for every account, so it is behind the
  // same gate as every other control. A developer recovering a test account's password reads
  // the link from the dev bar while signed in to their own developer account.
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
  // Makes the signed-in account look like one that predates the published documents, so the
  // acceptance gate can be walked through in a browser. Development builds only, and it only
  // ever removes the caller's own acceptance rows.
  r.post('/forget-policy-acceptances', (c) => {
    const ctx = c.get('ctx');
    const userId = c.get('user').id;
    const removed = ctx.db
      .delete(t.policyAcceptances)
      .where(eq(t.policyAcceptances.userId, userId))
      .run().changes;
    return c.json({ removed });
  });
  return r;
}
