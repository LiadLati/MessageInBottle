import { Hono } from 'hono';
import { ReleasePreviewRequestSchema, ReleaseRequestSchema } from '@mib/shared';
import { getSentBottle, listSentBottles } from '../../services/bottles.js';
import { previewRelease, releaseBottle } from '../../services/release.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { jsonBody } from '../validate.js';

export function bottleRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth);
  r.get('/sent', (c) => c.json({ bottles: listSentBottles(c.get('ctx'), c.get('user')) }));
  r.get('/sent/:id', (c) =>
    c.json({ bottle: getSentBottle(c.get('ctx'), c.get('user'), c.req.param('id')) }),
  );
  r.post('/preview', jsonBody(ReleasePreviewRequestSchema), (c) =>
    c.json(previewRelease(c.get('ctx'), c.get('user'), c.req.valid('json').recipientId)),
  );
  r.post('/release', jsonBody(ReleaseRequestSchema), (c) => {
    const ctx = c.get('ctx');
    const user = c.get('user');
    const outcome = releaseBottle(ctx, user, c.req.valid('json'));
    const bottle = getSentBottle(ctx, user, outcome.bottleId);
    return c.json({ bottle, replayed: outcome.replayed }, outcome.replayed ? 200 : 201);
  });
  return r;
}
