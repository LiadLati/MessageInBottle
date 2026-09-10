import { Hono } from 'hono';
import { BlockUserRequestSchema, SendFriendRequestSchema } from '@mib/shared';
import {
  acceptFriendRequest,
  blockUser,
  listFriends,
  sendFriendRequest,
} from '../../services/friends.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { jsonBody } from '../validate.js';

export function friendRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth);
  r.get('/', (c) => c.json(listFriends(c.get('ctx'), c.get('user').id)));
  r.post('/requests', jsonBody(SendFriendRequestSchema), (c) => {
    sendFriendRequest(c.get('ctx'), c.get('user').id, c.req.valid('json').username);
    return c.body(null, 204);
  });
  r.post('/requests/:id/accept', (c) => {
    acceptFriendRequest(c.get('ctx'), c.get('user').id, c.req.param('id'));
    return c.body(null, 204);
  });
  r.post('/blocks', jsonBody(BlockUserRequestSchema), (c) => {
    blockUser(c.get('ctx'), c.get('user').id, c.req.valid('json').username);
    return c.body(null, 204);
  });
  return r;
}
