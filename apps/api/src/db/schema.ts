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
  // Salted scrypt hash (see lib/password.ts). Null means the account cannot sign in: rows that
  // predate authentication, or accounts whose password was cleared.
  passwordHash: text('password_hash'),
  passwordUpdatedAt: integer('password_updated_at'),
  // Normalized (trimmed, lower-case) and unique; null for accounts that predate e-mail.
  email: text('email').unique(),
  // The IANA zone this account's nights are counted in (spec §9.3), first learned from the
  // device and re-synced on every app start or resume, and the journey-clock instant it took
  // effect. Nights are walked from that instant only, so a change never reaches into the past.
  timeZone: text('time_zone'),
  timeZoneSince: integer('time_zone_since'),
});

// Password-reset tokens: only the SHA-256 of the token is stored, each token is single-use and
// expires 30 minutes after it was requested. Rows are kept after use for auditing.
export const passwordResets = sqliteTable(
  'password_resets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    // Set when a newer request or a completed reset supersedes this token.
    invalidatedAt: integer('invalidated_at'),
  },
  (t) => [index('password_resets_user_idx').on(t.userId)],
);

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
  // Real-world attribution for catalogue shores (null for the original fictional shores):
  // the ISO 3166-1 numeric id of the dataset geometry, its display name and the body of water.
  countryId: text('country_id'),
  countryName: text('country_name'),
  sea: text('sea'),
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
    // Where and when the sea ended the journey (state = lost). Persisted once at the outcome so
    // the marker never moves and no client can re-derive a different spot (spec §9, §11 inv. 7).
    outcomeAt: integer('outcome_at'),
    outcomeProgress: real('outcome_progress'),
    outcomeChartX: integer('outcome_chart_x'),
    outcomeChartY: integer('outcome_chart_y'),
    outcomeLng: real('outcome_lng'),
    outcomeLat: real('outcome_lat'),
    // The risk policy this journey sails under (RISK_POLICY_VERSION at release). Null for
    // journeys released before automatic outcomes were enabled: they are never put at risk.
    riskPolicyVersion: integer('risk_policy_version'),
    // Public listing of an adrift bottle: listed until the deadline; `public_expired_at` is set
    // once by the worker when the deadline passed with nobody having opened it.
    publicDeadlineAt: integer('public_deadline_at'),
    publicExpiredAt: integer('public_expired_at'),
  },
  (t) => [
    index('bottles_sender_idx').on(t.senderId),
    index('bottles_recipient_state_idx').on(t.recipientId, t.state),
    index('bottles_state_idx').on(t.state),
  ],
);

// Per-account visibility of a terminal marker on the private map (a sunk bottle's red X).
// `seen_at`: the marker was inside this user's visible viewport while the page was active.
// `acknowledged_at`: the user left the private map after seeing it; the marker is hidden from
// later visits. Rows are per (user, bottle) so the record survives refreshes and devices.
export const bottleOutcomeViews = sqliteTable(
  'bottle_outcome_views',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    bottleId: text('bottle_id')
      .notNull()
      .references(() => bottles.id),
    seenAt: integer('seen_at'),
    acknowledgedAt: integer('acknowledged_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bottleId] })],
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
    // What the row is about (NotificationKind). Null on rows written before the inbox existed;
    // those are classified from their dedupe key when listed.
    kind: text('kind'),
    message: text('message').notNull(),
    createdAt: integer('created_at').notNull(),
    readAt: integer('read_at'),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);

// A bottle found adrift and opened by someone who is not its sender. The bottle id is the
// primary key, so the insert itself decides the single winner of a race: whoever commits first
// owns the reading, everyone else is told it is gone. Opening never changes the journey outcome
// (the bottle stays `lost`), so the sender keeps their letter, passport and history.
export const publicOpenings = sqliteTable(
  'public_openings',
  {
    bottleId: text('bottle_id')
      .primaryKey()
      .references(() => bottles.id),
    openedById: text('opened_by_id')
      .notNull()
      .references(() => users.id),
    openedAt: integer('opened_at').notNull(),
    // The finder's one reading session: served again only until this moment, and never after
    // an explicit close. Legacy rows (both null) grant no reread.
    sessionExpiresAt: integer('session_expires_at'),
    closedAt: integer('closed_at'),
  },
  (t) => [index('public_openings_opener_idx').on(t.openedById, t.openedAt)],
);

// One row per (bottle, night) once the night's risk decision has been taken, storm night or
// not — so a retry, a restart or a clock change can never take it again. `eligible` counts
// towards the five-decision cap; `lost` records that this decision ended the journey.
export const riskDecisions = sqliteTable(
  'risk_decisions',
  {
    id: text('id').primaryKey(),
    bottleId: text('bottle_id')
      .notNull()
      .references(() => bottles.id),
    nightKey: text('night_key').notNull(),
    policyVersion: integer('policy_version').notNull(),
    stormStartsAt: integer('storm_starts_at'),
    stormEndsAt: integer('storm_ends_at'),
    decisionAt: integer('decision_at').notNull(),
    eligible: integer('eligible', { mode: 'boolean' }).notNull(),
    lost: integer('lost', { mode: 'boolean' }).notNull(),
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('risk_decisions_bottle_night_idx').on(t.bottleId, t.nightKey)],
);

export const devClock = sqliteTable('dev_clock', {
  id: integer('id').primaryKey(),
  offsetMs: integer('offset_ms').notNull().default(0),
});
