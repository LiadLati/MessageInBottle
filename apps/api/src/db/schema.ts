import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// All timestamps are epoch milliseconds of *server* time (spec §11 invariant 7).
// No user GPS coordinates are stored anywhere. Chart positions are abstract sea-chart units;
// shores and waypoints additionally carry fictional geographic anchors for the world map.

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  shoreId: text('shore_id').references(() => shores.id),
  status: text('status', { enum: ['active', 'deleted'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const friendships = sqliteTable(
  'friendships',
  {
    id: text('id').primaryKey(),
    // Canonical ordering (userLowId < userHighId) so a pair has exactly one row.
    userLowId: text('user_low_id')
      .notNull()
      .references(() => users.id),
    userHighId: text('user_high_id')
      .notNull()
      .references(() => users.id),
    requestedById: text('requested_by_id')
      .notNull()
      .references(() => users.id),
    status: text('status', { enum: ['pending', 'accepted'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    acceptedAt: integer('accepted_at'),
  },
  (t) => [uniqueIndex('friendships_pair_idx').on(t.userLowId, t.userHighId)],
);

export const blocks = sqliteTable(
  'blocks',
  {
    blockerId: text('blocker_id')
      .notNull()
      .references(() => users.id),
    blockedId: text('blocked_id')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })],
);

export const shores = sqliteTable('shores', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  chartX: integer('chart_x').notNull(),
  chartY: integer('chart_y').notNull(),
  lng: real('lng'),
  lat: real('lat'),
  capacity: integer('capacity').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
});

export const routeGraphVersions = sqliteTable('route_graph_versions', {
  version: integer('version').primaryKey(),
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
});

export const routeNodes = sqliteTable(
  'route_nodes',
  {
    id: text('id').notNull(),
    graphVersion: integer('graph_version')
      .notNull()
      .references(() => routeGraphVersions.version),
    kind: text('kind', { enum: ['shore', 'waypoint', 'island'] }).notNull(),
    shoreId: text('shore_id').references(() => shores.id),
    chartX: integer('chart_x').notNull(),
    chartY: integer('chart_y').notNull(),
    lng: real('lng'),
    lat: real('lat'),
  },
  (t) => [primaryKey({ columns: [t.graphVersion, t.id] })],
);

export const routeEdges = sqliteTable(
  'route_edges',
  {
    graphVersion: integer('graph_version')
      .notNull()
      .references(() => routeGraphVersions.version),
    fromNodeId: text('from_node_id').notNull(),
    toNodeId: text('to_node_id').notNull(),
    length: integer('length').notNull(),
  },
  (t) => [primaryKey({ columns: [t.graphVersion, t.fromNodeId, t.toNodeId] })],
);

export const letters = sqliteTable('letters', {
  id: text('id').primaryKey(),
  text: text('text').notNull(),
  characters: integer('characters').notNull(),
  originalFont: text('original_font').notNull(),
  disclosureVersion: integer('disclosure_version').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const bottles = sqliteTable(
  'bottles',
  {
    id: text('id').primaryKey(),
    senderId: text('sender_id')
      .notNull()
      .references(() => users.id),
    recipientId: text('recipient_id')
      .notNull()
      .references(() => users.id),
    letterId: text('letter_id')
      .notNull()
      .references(() => letters.id),
    senderNameSnapshot: text('sender_name_snapshot').notNull(),
    recipientNameSnapshot: text('recipient_name_snapshot').notNull(),
    originShoreId: text('origin_shore_id')
      .notNull()
      .references(() => shores.id),
    originShoreName: text('origin_shore_name').notNull(),
    destinationShoreId: text('destination_shore_id')
      .notNull()
      .references(() => shores.id),
    destinationShoreName: text('destination_shore_name').notNull(),
    state: text('state').notNull(),
    // Optimistic version: every state transition bumps it (spec §11 invariant 2).
    version: integer('version').notNull().default(1),
    moderationStatus: text('moderation_status').notNull().default('clear'),
    releasedAt: integer('released_at').notNull(),
    deliveredAt: integer('delivered_at'),
    openedAt: integer('opened_at'),
    completedAt: integer('completed_at'),
    lossReason: text('loss_reason'),
    agingProfile: text('aging_profile', { mode: 'json' }),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('bottles_sender_idx').on(t.senderId),
    index('bottles_recipient_state_idx').on(t.recipientId, t.state),
    index('bottles_state_idx').on(t.state),
  ],
);

export const routePlans = sqliteTable(
  'route_plans',
  {
    id: text('id').primaryKey(),
    bottleId: text('bottle_id')
      .notNull()
      .references(() => bottles.id),
    planVersion: integer('plan_version').notNull(),
    graphVersion: integer('graph_version').notNull(),
    nodeIds: text('node_ids', { mode: 'json' }).$type<string[]>().notNull(),
    totalLength: integer('total_length').notNull(),
    plannedDurationMs: integer('planned_duration_ms').notNull(),
    // Movement along this plan starts at startsAt from startProgress (rescue continuity).
    startsAt: integer('starts_at').notNull(),
    startProgress: integer('start_progress').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('route_plans_bottle_version_idx').on(t.bottleId, t.planVersion)],
);

export const journeyEvents = sqliteTable(
  'journey_events',
  {
    id: text('id').primaryKey(),
    bottleId: text('bottle_id')
      .notNull()
      .references(() => bottles.id),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    occurredAt: integer('occurred_at').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [uniqueIndex('journey_events_bottle_seq_idx').on(t.bottleId, t.seq)],
);

export const capacityReservations = sqliteTable(
  'capacity_reservations',
  {
    id: text('id').primaryKey(),
    bottleId: text('bottle_id')
      .notNull()
      .unique()
      .references(() => bottles.id),
    shoreId: text('shore_id')
      .notNull()
      .references(() => shores.id),
    status: text('status', { enum: ['held', 'released'] }).notNull(),
    reservedAt: integer('reserved_at').notNull(),
    releasedAt: integer('released_at'),
  },
  (t) => [index('capacity_reservations_shore_status_idx').on(t.shoreId, t.status)],
);

export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: text('response_body').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.scope, t.key] })],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type').notNull(),
    bottleId: text('bottle_id').references(() => bottles.id),
    // Dedupe key so retries/replays never create a second notification (spec §14).
    dedupeKey: text('dedupe_key').notNull().unique(),
    message: text('message').notNull(),
    createdAt: integer('created_at').notNull(),
    readAt: integer('read_at'),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);

export const devClock = sqliteTable('dev_clock', {
  id: integer('id').primaryKey(),
  offsetMs: integer('offset_ms').notNull().default(0),
});
