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
  // The latest valid IANA zone a device reported for this account, and the journey-clock
  // instant the server accepted it. The full history the map clock and storms follow is
  // `account_zone_changes`; these two columns mirror its latest device entry.
  timeZone: text('time_zone'),
  timeZoneSince: integer('time_zone_since'),
  // Set when this account's shore became full (100 bottles unread or on their way) and the
  // owner was told; cleared when it drops below full again. One notice per full episode.
  shoreFullSince: integer('shore_full_since'),
  // Granted only by the server-side tools (tools/grant-admin.ts, tools/grant-developer.ts), by
  // stable user id. Registration never sets a role and no request body is ever read for one.
  //
  //   member    — an ordinary account.
  //   admin     — may review and decide reports and appeals. Gets no DEV controls.
  //   developer — may use the DEV simulation panel, and only outside production. Has no
  //               moderation authority whatsoever: admin routes answer 403.
  //
  // The two are deliberately disjoint: an account holds one role, so neither can quietly
  // acquire the other's powers. Stored as plain text, so this list widens without a migration.
  role: text('role', { enum: ['member', 'admin', 'developer'] })
    .notNull()
    .default('member'),
  roleGrantedAt: integer('role_granted_at'),
  roleGrantedBy: text('role_granted_by'),
  // When the account was deleted at its owner's request. The row itself survives so that the
  // letters other people legitimately hold, and any moderation record that must be kept, do
  // not lose their foreign key; everything identifying it is cleared (services/deletion.ts).
  deletedAt: integer('deleted_at'),
});

// What each account accepted or acknowledged, per document and version, and when. Append-only:
// a newer version accepted later is a new row, so the history of what a person agreed to is
// kept. The latest row per (user, document) is compared with the current version to decide
// whether the person must be asked again. Accounts that predate this table have no rows and
// are never treated as having accepted anything.
export const policyAcceptances = sqliteTable(
  'policy_acceptances',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    document: text('document', { enum: ['terms', 'guidelines', 'privacy'] }).notNull(),
    version: text('version').notNull(),
    action: text('action', { enum: ['accepted', 'acknowledged'] }).notNull(),
    // Where the person did it: the registration form, or the "updated terms" screen later.
    source: text('source', { enum: ['registration', 'update'] }).notNull(),
    acceptedAt: integer('accepted_at').notNull(),
  },
  (t) => [index('policy_acceptances_user_idx').on(t.userId, t.document, t.acceptedAt)],
);

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
    // Set when a finder blocked the anonymous writer of a bottle found adrift (product decision
    // 12): the finder never learns who that is, so their Blocked list names the bottle instead.
    foundBottleId: text('found_bottle_id'),
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

// One row per (bottle, storm) once that storm's risk decision has been taken — so a retry, a
// restart or a clock change can never take it again. Under policy v4 `night_key` is the id of the
// account's weather roll; rows from v1–v3 keep the local night key they were written with.
// `eligible` counts towards the five-decision cap; `lost` records that it ended the journey.
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

// The account's authoritative map clock over time (policy v4): every accepted change, never
// edited or deleted. Storms, rolls and risk read the zone in force at each instant from here, so
// a worker catching up after downtime walks exactly the nights the map showed.
//   device  — a valid IANA zone reported by a signed-in device;
//   harbour — before any device report: the chosen harbour's nautical zone;
//   utc     — before any device report, with no harbour to derive a zone from.
export const accountZoneChanges = sqliteTable(
  'account_zone_changes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    zone: text('zone').notNull(),
    source: text('source', { enum: ['device', 'harbour', 'utc'] }).notNull(),
    effectiveAt: integer('effective_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('account_zone_changes_user_idx').on(t.userId, t.effectiveAt)],
);

// One row per storm-eligibility roll (policy v4): the proof that the roll happened, what it
// decided and what became of its storm. Rows are never deleted or rerolled; the unique index on
// (user, rolled_at) and the 24-hour spacing checked in the same transaction stop a retry, a
// restart or a second worker from rolling twice.
export const weatherRolls = sqliteTable(
  'weather_rolls',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    policyVersion: integer('policy_version').notNull(),
    rolledAt: integer('rolled_at').notNull(),
    zone: text('zone').notNull(),
    nightStartsAt: integer('night_starts_at').notNull(),
    nightEndsAt: integer('night_ends_at').notNull(),
    outcome: text('outcome', { enum: ['calm', 'storm'] }).notNull(),
    stormStartsAt: integer('storm_starts_at'),
    stormEndsAt: integer('storm_ends_at'),
    decisionAt: integer('decision_at'),
    // Set once the midpoint decisions for every eligible bottle were taken (in one commit).
    decidedAt: integer('decided_at'),
    // Set when the map turned to day before the midpoint: the pending decision is cancelled
    // and the roll stays consumed.
    cancelledAt: integer('cancelled_at'),
    cancelReason: text('cancel_reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('weather_rolls_user_rolled_idx').on(t.userId, t.rolledAt),
    index('weather_rolls_pending_idx').on(t.outcome, t.decidedAt, t.cancelledAt, t.decisionAt),
  ],
);

// When each risk policy version took over, recorded once at first boot. Accounts roll only from
// v4's activation, so no past night is ever given a v4 storm after the fact.
export const riskPolicyActivations = sqliteTable('risk_policy_activations', {
  version: integer('version').primaryKey(),
  activatedAt: integer('activated_at').notNull(),
});

export const devClock = sqliteTable('dev_clock', {
  id: integer('id').primaryKey(),
  offsetMs: integer('offset_ms').notNull().default(0),
});

// ---------- reporting and moderation (spec §16) ----------

// One case per reported letter: every report about the same bottle joins it, and a case can
// produce at most one violation. The letter text is copied in as protected evidence when the
// first report arrives, so a later removal, edit or moderation change never loses what was
// reviewed. The ai_* columns are the persistent review queue: a case stays `queued` until the
// local model has answered, however long the model or the machine is away.
export const moderationCases = sqliteTable(
  'moderation_cases',
  {
    id: text('id').primaryKey(),
    bottleId: text('bottle_id')
      .notNull()
      .unique()
      .references(() => bottles.id),
    letterId: text('letter_id')
      .notNull()
      .references(() => letters.id),
    senderId: text('sender_id')
      .notNull()
      .references(() => users.id),
    recipientId: text('recipient_id')
      .notNull()
      .references(() => users.id),
    // Where the first reporter read it: their own shore, or the public ocean as a finder.
    context: text('context', { enum: ['shore', 'public'] }).notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'rejected'] })
      .notNull()
      .default('pending'),
    evidenceText: text('evidence_text').notNull(),
    evidenceFont: text('evidence_font').notNull(),
    evidenceCharacters: integer('evidence_characters').notNull(),
    // Set when a retention run has cleared the evidence text from a finally settled case. The
    // case, its decision and its violation survive; only the copied letter goes. Null on every
    // case until a retention policy is configured and switched on (services/retention.ts).
    evidenceRedactedAt: integer('evidence_redacted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    aiStatus: text('ai_status', { enum: ['queued', 'running', 'done', 'failed'] })
      .notNull()
      .default('queued'),
    aiAttempts: integer('ai_attempts').notNull().default(0),
    aiNextAttemptAt: integer('ai_next_attempt_at'),
    aiStartedAt: integer('ai_started_at'),
    aiVerdict: text('ai_verdict', { enum: ['accept', 'reject', 'uncertain'] }),
    aiReason: text('ai_reason'),
    aiUncertainty: text('ai_uncertainty'),
    aiTranslation: text('ai_translation'),
    aiLanguage: text('ai_language'),
    aiModel: text('ai_model'),
    aiCompletedAt: integer('ai_completed_at'),
    aiLastError: text('ai_last_error'),
    // The model flagged a possible child-safety issue. It changes only where the case sits in
    // the human queue: the model never decides, sanctions or bans (product decision 2).
    aiChildSafety: integer('ai_child_safety', { mode: 'boolean' }).notNull().default(false),
    // Set once the case is marked urgent child-safety review (by the model's flag or the
    // report reason); urgent cases lead the administrator's queue.
    urgentAt: integer('urgent_at'),
    decidedOutcome: text('decided_outcome', { enum: ['accepted', 'rejected'] }),
    decidedBy: text('decided_by', { enum: ['admin', 'ai'] }),
    decidedByUserId: text('decided_by_user_id').references(() => users.id),
    decidedAt: integer('decided_at'),
    decisionReason: text('decision_reason'),
    // A documented legal or immediate child-safety reason to keep this case's evidence beyond
    // the ordinary seven days (services/retention.ts). A hold is always explicit: it records
    // why, who placed it and when, and releasing it returns the case to the normal
    // calculation. There is no way to retain evidence indefinitely without one of these rows.
    holdReason: text('hold_reason', { enum: ['legal', 'child_safety'] }),
    holdNote: text('hold_note'),
    holdByUserId: text('hold_by_user_id').references(() => users.id),
    holdAt: integer('hold_at'),
    holdReleasedAt: integer('hold_released_at'),
    holdReleasedByUserId: text('hold_released_by_user_id').references(() => users.id),
  },
  (t) => [
    index('moderation_cases_status_idx').on(t.status, t.createdAt),
    index('moderation_cases_ai_idx').on(t.aiStatus, t.aiNextAttemptAt),
    index('moderation_cases_sender_idx').on(t.senderId),
  ],
);

// A reader's report. One per reader per case; a second report by the same reader is a no-op.
// `hidden` records that the reporter chose to hide the letter from their own reads at once.
export const letterReports = sqliteTable(
  'letter_reports',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => moderationCases.id),
    reporterId: text('reporter_id')
      .notNull()
      .references(() => users.id),
    reason: text('reason').notNull(),
    explanation: text('explanation'),
    context: text('context', { enum: ['shore', 'public'] }).notNull(),
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('letter_reports_case_reporter_idx').on(t.caseId, t.reporterId),
    index('letter_reports_reporter_idx').on(t.reporterId),
  ],
);

// An accepted report. The case id is unique, so a case yields one violation at most. A revoked
// violation (an accepted appeal) stays as history but no longer counts towards the account's
// standing; `acknowledged_at` is the one-time warning the sender has seen.
export const violations = sqliteTable(
  'violations',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .unique()
      .references(() => moderationCases.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    bottleId: text('bottle_id')
      .notNull()
      .references(() => bottles.id),
    category: text('category').notNull(),
    decidedAt: integer('decided_at').notNull(),
    decidedBy: text('decided_by', { enum: ['admin', 'ai'] }).notNull(),
    decidedByUserId: text('decided_by_user_id').references(() => users.id),
    reason: text('reason'),
    revokedAt: integer('revoked_at'),
    revokedByUserId: text('revoked_by_user_id').references(() => users.id),
    acknowledgedAt: integer('acknowledged_at'),
    createdAt: integer('created_at').notNull(),
    // The single appeal opportunity (spec §16.4). The appeal is offered when the decision
    // notice is actually put in front of the sender, and it stays offered until they resolve
    // it one way or the other: closing the app or reloading decides nothing.
    //
    //   noticePresentedAt — first time the server handed the notice to the sender's client.
    //   appealWaivedAt    — they explicitly confirmed "Skip appeal". Permanent.
    //
    // Both are written by the server alone, and both are idempotent: the first value wins.
    noticePresentedAt: integer('notice_presented_at'),
    appealWaivedAt: integer('appeal_waived_at'),
    // `critical` is the confirmed child-safety classification, which bans immediately instead
    // of walking the warning ladder. Only an administrator can set it -- the AI has no path to
    // it at all (services/admin.ts) -- and it still carries the same single appeal.
    severity: text('severity', { enum: ['standard', 'critical'] })
      .notNull()
      .default('standard'),
    // The appeal window (30 days) opens here. Null means the original decision time. An
    // escalation to a critical ban after the appeal was waived or had lapsed opens one new
    // window from the escalation (product decision 2), recorded in appealReopenedAt.
    appealWindowStartsAt: integer('appeal_window_starts_at'),
    appealReopenedAt: integer('appeal_reopened_at'),
  },
  (t) => [index('violations_user_idx').on(t.userId, t.decidedAt)],
);

// One appeal per violation (unique), decided once. A rejected appeal is final.
export const appeals = sqliteTable(
  'appeals',
  {
    id: text('id').primaryKey(),
    violationId: text('violation_id')
      .notNull()
      .unique()
      .references(() => violations.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    text: text('text').notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'rejected'] })
      .notNull()
      .default('pending'),
    createdAt: integer('created_at').notNull(),
    decidedByUserId: text('decided_by_user_id').references(() => users.id),
    decidedAt: integer('decided_at'),
    decisionReason: text('decision_reason'),
  },
  (t) => [index('appeals_status_idx').on(t.status, t.createdAt)],
);

// An append-only record of the moderation actions that change what a person may do: the
// decision notice being presented, an appeal waived, a case decided, an appeal decided, a
// critical child-safety classification, and legal or child-safety holds placed and released.
//
// It exists so those actions can be reconstructed after the evidence itself is redacted, and
// it is written inside the same transaction as the action it describes -- there is no path
// that changes standing without leaving a row here. `actorUserId` is null when the actor is
// the subject themselves (waiving their own appeal) or the server (a retention run).
export const moderationAudit = sqliteTable(
  'moderation_audit',
  {
    id: text('id').primaryKey(),
    action: text('action').notNull(),
    caseId: text('case_id').references(() => moderationCases.id),
    violationId: text('violation_id').references(() => violations.id),
    appealId: text('appeal_id').references(() => appeals.id),
    // Whose standing the action concerns.
    subjectUserId: text('subject_user_id').references(() => users.id),
    actorUserId: text('actor_user_id').references(() => users.id),
    actorRole: text('actor_role', { enum: ['admin', 'developer', 'member', 'system'] }).notNull(),
    // Free-text reason where the action requires one (a critical classification, a hold).
    reason: text('reason'),
    detail: text('detail'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('moderation_audit_case_idx').on(t.caseId, t.createdAt),
    index('moderation_audit_subject_idx').on(t.subjectUserId, t.createdAt),
  ],
);
