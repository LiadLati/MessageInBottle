import { and, count, eq } from 'drizzle-orm';
import {
  normalizeLetterText,
  validateLetterText,
  type ReleasePreviewResponse,
  type ReleaseRejection,
  type ReleaseRequest,
  type RouteView,
} from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { DISCLOSURE_VERSION } from '../config.js';
import {
  journeyDurationMs,
  pathGeoPoints,
  pathPoints,
  planRoute,
  type PlannedPath,
  type RouteGraph,
} from '../domain/routing.js';
import { newId, sha256 } from '../lib/ids.js';
import { AppError, conflict } from '../lib/errors.js';
import { geoOf, getShore, loadActiveGraph, toShoreDto } from './chart.js';
import type { AppContext, AuthUser } from './context.js';
import { areAcceptedFriends, isBlockedEitherWay } from './friends.js';

export class ReleaseRejectedError extends AppError {
  constructor(public readonly rejection: ReleaseRejection) {
    super(422, 'release_rejected', REJECTION_MESSAGES[rejection], { rejection });
  }
}

export const REJECTION_MESSAGES: Record<ReleaseRejection, string> = {
  sender_has_no_shore: 'Choose your shore before releasing a bottle.',
  recipient_not_found: 'That recipient is not available.',
  self_send: 'A bottle cannot be addressed to yourself.',
  not_friends: 'You can only send bottles to approved friends.',
  recipient_has_no_shore: 'Your friend has not chosen a shore yet.',
  recipient_unavailable: 'Delivery to this friend is unavailable.',
  shore_full: "Your friend's shore is full right now. Your draft is kept; try again later.",
  route_unavailable: 'No connected sea route reaches that shore.',
  invalid_letter: 'The letter is empty or too long.',
};

interface Eligibility {
  sender: typeof t.users.$inferSelect;
  recipient: typeof t.users.$inferSelect;
  originShore: typeof t.shores.$inferSelect;
  destinationShore: typeof t.shores.$inferSelect;
  graph: RouteGraph;
  path: PlannedPath;
  plannedDurationMs: number;
}

export function heldReservations(db: DbOrTx, shoreId: string): number {
  const row = db
    .select({ n: count() })
    .from(t.capacityReservations)
    .where(
      and(eq(t.capacityReservations.shoreId, shoreId), eq(t.capacityReservations.status, 'held')),
    )
    .get();
  return row?.n ?? 0;
}

// Runs every server-side eligibility rule of spec §5.1 step 6 in a fixed order. Called inside
// the release transaction so capacity is evaluated against committed state only.
export function checkEligibility(
  ctx: AppContext,
  db: DbOrTx,
  senderId: string,
  recipientId: string,
):
  | { ok: true; value: Eligibility }
  | { ok: false; rejection: ReleaseRejection; partial: Partial<Eligibility> } {
  const sender = db.select().from(t.users).where(eq(t.users.id, senderId)).get();
  if (!sender) throw new AppError(401, 'unauthorized', 'sender missing');
  if (!sender.shoreId) return { ok: false, rejection: 'sender_has_no_shore', partial: {} };
  const originShore = getShore(db, sender.shoreId);
  if (!originShore) return { ok: false, rejection: 'sender_has_no_shore', partial: {} };
  const partial: Partial<Eligibility> = { sender, originShore };

  if (recipientId === senderId) return { ok: false, rejection: 'self_send', partial };
  const recipient = db.select().from(t.users).where(eq(t.users.id, recipientId)).get();
  if (!recipient || recipient.status !== 'active')
    return { ok: false, rejection: 'recipient_not_found', partial };
  if (isBlockedEitherWay(db, senderId, recipientId))
    return { ok: false, rejection: 'recipient_unavailable', partial };
  if (!areAcceptedFriends(db, senderId, recipientId))
    return { ok: false, rejection: 'not_friends', partial };
  if (!recipient.shoreId) return { ok: false, rejection: 'recipient_has_no_shore', partial };
  const destinationShore = getShore(db, recipient.shoreId);
  if (!destinationShore) return { ok: false, rejection: 'recipient_has_no_shore', partial };
  partial.recipient = recipient;
  partial.destinationShore = destinationShore;

  const graph = loadActiveGraph(db);
  const path = planRoute(graph, originShore.id, destinationShore.id);
  if (!path) return { ok: false, rejection: 'route_unavailable', partial };
  partial.graph = graph;
  partial.path = path;

  if (heldReservations(db, destinationShore.id) >= destinationShore.capacity) {
    return { ok: false, rejection: 'shore_full', partial };
  }
  const plannedDurationMs = journeyDurationMs(
    path.totalLength,
    ctx.config.msPerChartUnit,
    ctx.config.minJourneyMs,
  );
  return {
    ok: true,
    value: { sender, recipient, originShore, destinationShore, graph, path, plannedDurationMs },
  };
}

export function routeView(
  graph: RouteGraph,
  path: PlannedPath,
  plannedDurationMs: number,
  version = 1,
): RouteView {
  return {
    version,
    nodeIds: path.nodeIds,
    points: pathPoints(graph, path.nodeIds),
    geoPoints: pathGeoPoints(graph, path.nodeIds),
    totalLength: path.totalLength,
    plannedDurationMs,
  };
}

export function previewRelease(
  ctx: AppContext,
  user: AuthUser,
  recipientId: string,
): ReleasePreviewResponse {
  const result = checkEligibility(ctx, ctx.db, user.id, recipientId);
  const partial = result.ok ? result.value : result.partial;
  const dest = partial.destinationShore;
  const route =
    partial.graph && partial.path
      ? routeView(
          partial.graph,
          partial.path,
          journeyDurationMs(
            partial.path.totalLength,
            ctx.config.msPerChartUnit,
            ctx.config.minJourneyMs,
          ),
        )
      : null;
  return {
    eligible: result.ok,
    rejection: result.ok ? null : result.rejection,
    originShore: partial.originShore ? toShoreDto(partial.originShore) : null,
    destinationShore: dest
      ? {
          id: dest.id,
          name: dest.name,
          position: { x: dest.chartX, y: dest.chartY },
          geo: geoOf(dest),
        }
      : null,
    route,
  };
}

export interface ReleaseOutcome {
  bottleId: string;
  replayed: boolean;
}

const RELEASE_SCOPE = 'release';

function requestFingerprint(userId: string, req: ReleaseRequest): string {
  return sha256(JSON.stringify([userId, req.recipientId, normalizeLetterText(req.text), req.font]));
}

// Spec §11 invariant 1 & 5: the letter, bottle, route plan, capacity reservation, first event and
// idempotency record commit in one transaction. SQLite serializes writers, so the capacity count
// inside the transaction cannot race with another release.
export function releaseBottle(
  ctx: AppContext,
  user: AuthUser,
  req: ReleaseRequest,
): ReleaseOutcome {
  const fingerprint = requestFingerprint(user.id, req);
  return ctx.db.transaction((tx) => {
    const prior = tx
      .select()
      .from(t.idempotencyKeys)
      .where(
        and(
          eq(t.idempotencyKeys.userId, user.id),
          eq(t.idempotencyKeys.scope, RELEASE_SCOPE),
          eq(t.idempotencyKeys.key, req.idempotencyKey),
        ),
      )
      .get();
    if (prior) {
      if (prior.requestHash !== fingerprint) {
        throw conflict(
          'idempotency_mismatch',
          'this idempotency key was used for a different release',
        );
      }
      const body = JSON.parse(prior.responseBody) as { bottleId: string };
      return { bottleId: body.bottleId, replayed: true };
    }

    const letter = validateLetterText(req.text);
    if (!letter.ok) throw new ReleaseRejectedError('invalid_letter');
    const eligibility = checkEligibility(ctx, tx, user.id, req.recipientId);
    if (!eligibility.ok) throw new ReleaseRejectedError(eligibility.rejection);
    const e = eligibility.value;

    const now = ctx.clock.now();
    const letterId = newId('ltr');
    const bottleId = newId('btl');
    tx.insert(t.letters)
      .values({
        id: letterId,
        text: normalizeLetterText(req.text),
        characters: letter.characters,
        originalFont: req.font,
        disclosureVersion: DISCLOSURE_VERSION,
        createdAt: now,
      })
      .run();
    tx.insert(t.bottles)
      .values({
        id: bottleId,
        senderId: e.sender.id,
        recipientId: e.recipient.id,
        letterId,
        senderNameSnapshot: e.sender.displayName,
        recipientNameSnapshot: e.recipient.displayName,
        originShoreId: e.originShore.id,
        originShoreName: e.originShore.name,
        destinationShoreId: e.destinationShore.id,
        destinationShoreName: e.destinationShore.name,
        state: 'at_sea',
        version: 1,
        releasedAt: now,
        createdAt: now,
      })
      .run();
    tx.insert(t.routePlans)
      .values({
        id: newId('rtp'),
        bottleId,
        planVersion: 1,
        graphVersion: e.graph.version,
        nodeIds: e.path.nodeIds,
        totalLength: e.path.totalLength,
        plannedDurationMs: e.plannedDurationMs,
        startsAt: now,
        startProgress: 0,
        active: true,
        createdAt: now,
      })
      .run();
    tx.insert(t.capacityReservations)
      .values({
        id: newId('rsv'),
        bottleId,
        shoreId: e.destinationShore.id,
        status: 'held',
        reservedAt: now,
        releasedAt: null,
      })
      .run();
    tx.insert(t.journeyEvents)
      .values({
        id: newId('evt'),
        bottleId,
        seq: 1,
        type: 'released',
        occurredAt: now,
        payload: {
          originShoreId: e.originShore.id,
          destinationShoreId: e.destinationShore.id,
          routeVersion: 1,
        },
      })
      .run();
    tx.insert(t.idempotencyKeys)
      .values({
        userId: user.id,
        scope: RELEASE_SCOPE,
        key: req.idempotencyKey,
        requestHash: fingerprint,
        responseStatus: 201,
        responseBody: JSON.stringify({ bottleId }),
        createdAt: now,
      })
      .run();
    return { bottleId, replayed: false };
  });
}
