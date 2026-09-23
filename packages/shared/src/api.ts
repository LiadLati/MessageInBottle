import { z } from 'zod';
import { AccountPoliciesSchema } from './policies.js';
import { BOTTLE_STATES, JOURNEY_EVENT_TYPES, LOSS_REASONS } from './bottle-state.js';
import { LETTER_FONTS } from './fonts.js';
import { LETTER_MAX_BYTES, LETTER_MAX_CHARACTERS, countLetterCharacters } from './letter.js';

// ---------- primitives ----------
export const IdSchema = z.string().min(1).max(64);
export const UsernameSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9_]+$/i, 'letters, digits and underscore only');
export const IdempotencyKeySchema = z.string().min(8).max(128);

// Chart coordinates are an abstract, non-geographic sea chart (spec §6). Never GPS.
export const ChartPointSchema = z.object({ x: z.number(), y: z.number() });
export type ChartPoint = z.infer<typeof ChartPointSchema>;

// Geographic anchor of a fictional shore or sea waypoint on the world map (spec §6.1).
// Only app anchors carry these; user locations are never collected or stored.
export const GeoPointSchema = z.object({ lng: z.number(), lat: z.number() });
export type GeoPoint = z.infer<typeof GeoPointSchema>;

export const LetterFontSchema = z.enum(LETTER_FONTS);
export const BottleStateSchema = z.enum(BOTTLE_STATES);
export const JourneyEventTypeSchema = z.enum(JOURNEY_EVENT_TYPES);

export const LetterTextSchema = z
  .string()
  .max(LETTER_MAX_BYTES, `letter exceeds ${LETTER_MAX_BYTES} bytes`)
  .refine((t) => t.trim().length > 0, 'letter is empty')
  .refine(
    (t) => countLetterCharacters(t) <= LETTER_MAX_CHARACTERS,
    `letter exceeds ${LETTER_MAX_CHARACTERS} characters`,
  );

// ---------- auth (request schemas live in auth.ts) ----------

// The three roles an account can hold, and only ever one of them.
//
//   member    — an ordinary account.
//   admin     — reviews and decides reports and appeals. Gets no DEV controls.
//   developer — may use the DEV simulation panel, and only outside production. Has no
//               moderation authority: admin routes answer 403.
//
// Roles are granted server-side by CLI and read from the users row on every request. There is
// no registration field, header or request body that can set one.
export const ACCOUNT_ROLES = ['member', 'admin', 'developer'] as const;
export const AccountRoleSchema = z.enum(ACCOUNT_ROLES);
export type AccountRole = z.infer<typeof AccountRoleSchema>;

export const SessionResponseSchema = z.object({
  token: z.string(),
  user: z.object({
    id: IdSchema,
    username: z.string(),
    displayName: z.string(),
    shoreId: IdSchema.nullable(),
    // Only ever returned to the account owner; null for accounts created before e-mail existed.
    email: z.string().nullable(),
    // The IANA zone the account's nights are counted in (spec §9.3): first learned from the
    // device and re-synced whenever the app starts or resumes. Null until a device has said.
    timeZone: z.string().nullable(),
    // Granted only server-side (apps/api/src/tools/grant-admin.ts, grant-developer.ts); never
    // chosen at registration and never taken from a client. `admin` reviews and decides reports
    // and appeals; `developer` may use the DEV simulation panel outside production and has no
    // moderation authority at all. An account holds exactly one of them.
    role: AccountRoleSchema,
    // What this account has accepted against the current documents, and whether it must be
    // asked again before using the app (policies.ts).
    policies: AccountPoliciesSchema,
  }),
});

export const TimeZoneRequestSchema = z.object({ timeZone: z.string().min(1).max(64) });
export type TimeZoneRequest = z.infer<typeof TimeZoneRequestSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const MeResponseSchema = SessionResponseSchema.shape.user;
export type MeResponse = z.infer<typeof MeResponseSchema>;

// ---------- shores & chart ----------
export const ShoreSchema = z.object({
  id: IdSchema,
  name: z.string(),
  position: ChartPointSchema,
  geo: GeoPointSchema.nullable(),
  capacity: z.number().int().nonnegative(),
  // Body of water of a catalogue shore; null on the original fictional shores. Country names
  // are deliberately never sent to clients (spec §6.2): borders are drawn, names are not.
  sea: z.string().nullable(),
});
export type ShoreDto = z.infer<typeof ShoreSchema>;

// Selectable shores only: the sea-route graph stays on the server (it has tens of thousands of
// water nodes); bottles carry their own planned polyline.
export const ChartResponseSchema = z.object({
  graphVersion: z.number().int(),
  bounds: z.object({ width: z.number(), height: z.number() }),
  shores: z.array(ShoreSchema),
});
export type ChartResponse = z.infer<typeof ChartResponseSchema>;

export const SetShoreRequestSchema = z.object({ shoreId: IdSchema });

// ---------- friends ----------
export const FriendSchema = z.object({
  id: IdSchema,
  username: z.string(),
  displayName: z.string(),
  hasShore: z.boolean(),
});
export type FriendDto = z.infer<typeof FriendSchema>;

export const FriendRequestSchema = z.object({
  id: IdSchema,
  from: FriendSchema.pick({ id: true, username: true, displayName: true }),
  to: FriendSchema.pick({ id: true, username: true, displayName: true }),
  createdAt: z.string(),
});
export type FriendRequestDto = z.infer<typeof FriendRequestSchema>;

export const FriendsResponseSchema = z.object({
  friends: z.array(FriendSchema),
  incomingRequests: z.array(FriendRequestSchema),
  outgoingRequests: z.array(FriendRequestSchema),
  // Server-authoritative count of pending requests addressed to the caller (badge source).
  pendingIncomingCount: z.number().int().nonnegative(),
});
export type FriendsResponse = z.infer<typeof FriendsResponseSchema>;

export const SendFriendRequestSchema = z.object({ username: UsernameSchema });
export const BlockUserRequestSchema = z.object({ username: UsernameSchema });

// ---------- release ----------
export const ReleaseRequestSchema = z.object({
  recipientId: IdSchema,
  text: LetterTextSchema,
  font: LetterFontSchema,
  disclosureAcknowledged: z.literal(true),
  idempotencyKey: IdempotencyKeySchema,
});
export type ReleaseRequest = z.infer<typeof ReleaseRequestSchema>;

export const ReleasePreviewRequestSchema = z.object({ recipientId: IdSchema });

export const RELEASE_REJECTIONS = [
  'sender_has_no_shore',
  'recipient_not_found',
  'self_send',
  'not_friends',
  'recipient_has_no_shore',
  // Generic on purpose: a block in either direction must not be disclosed to the sender (spec §8.2).
  'recipient_unavailable',
  'shore_full',
  'route_unavailable',
  'invalid_letter',
] as const;
export type ReleaseRejection = (typeof RELEASE_REJECTIONS)[number];

export const RouteViewSchema = z.object({
  version: z.number().int(),
  nodeIds: z.array(IdSchema),
  points: z.array(ChartPointSchema),
  geoPoints: z.array(GeoPointSchema).nullable(),
  totalLength: z.number(),
  plannedDurationMs: z.number().int(),
});
export type RouteView = z.infer<typeof RouteViewSchema>;

export const ReleasePreviewResponseSchema = z.object({
  eligible: z.boolean(),
  rejection: z.enum(RELEASE_REJECTIONS).nullable(),
  originShore: ShoreSchema.nullable(),
  destinationShore: ShoreSchema.pick({
    id: true,
    name: true,
    position: true,
    geo: true,
  }).nullable(),
  route: RouteViewSchema.nullable(),
});
export type ReleasePreviewResponse = z.infer<typeof ReleasePreviewResponseSchema>;

// ---------- bottles (private sender passport) ----------
export const JourneyEventSchema = z.object({
  seq: z.number().int(),
  type: JourneyEventTypeSchema,
  occurredAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type JourneyEventDto = z.infer<typeof JourneyEventSchema>;

export const AgingProfileSchema = z.object({
  yellowing: z.number().min(0).max(1),
  wear: z.number().min(0).max(1),
  tears: z.array(z.object({ edge: z.enum(['top', 'right', 'bottom', 'left']), at: z.number() })),
  stains: z.array(z.object({ x: z.number(), y: z.number(), size: z.number() })),
});
export type AgingProfile = z.infer<typeof AgingProfileSchema>;

export const BottlePositionSchema = z.object({
  point: ChartPointSchema,
  geo: GeoPointSchema.nullable(),
  progress: z.number().min(0).max(1),
  asOf: z.string(),
});

export const LossReasonSchema = z.enum(LOSS_REASONS);

// A committed journey outcome (spec §9, §11): where and when the sea ended the delivery. Written
// once by the server; never derived on a client and never rerolled.
export const OutcomeSchema = z.object({
  reason: LossReasonSchema,
  at: z.string(),
  position: z.object({ point: ChartPointSchema, geo: GeoPointSchema.nullable() }),
  progress: z.number().min(0).max(1),
});
export type OutcomeDto = z.infer<typeof OutcomeSchema>;

// Per-account visibility of a terminal marker on the private map: `seenAt` once the marker has
// actually been inside the sender's viewport, `acknowledgedAt` once they left the map after
// seeing it. Both are server-persisted so a refresh never erases an unseen marker.
export const OutcomeVisibilitySchema = z.object({
  seenAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
});
export type OutcomeVisibilityDto = z.infer<typeof OutcomeVisibilitySchema>;

// A storm window of the server's risk schedule, sent so the map draws exactly the storms that
// can matter (and the ones that cannot: after the risk cap, they are scenery).
export const StormWindowSchema = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
});
export type StormWindowDto = z.infer<typeof StormWindowSchema>;

// Where an adrift bottle stands on the public map: listed until its deadline, opened by a
// finder, or removed unopened after 72 hours.
export const PublicListingSchema = z.object({
  deadlineAt: z.string(),
  status: z.enum(['listed', 'opened', 'expired']),
});
export type PublicListingDto = z.infer<typeof PublicListingSchema>;

export const SentBottleSchema = z.object({
  id: IdSchema,
  state: BottleStateSchema,
  version: z.number().int(),
  recipient: z.object({ id: IdSchema, displayName: z.string() }),
  originShore: z.object({ id: IdSchema, name: z.string() }),
  destinationShore: z.object({ id: IdSchema, name: z.string() }),
  releasedAt: z.string(),
  deliveredAt: z.string().nullable(),
  openedAt: z.string().nullable(),
  elapsedMs: z.number().int(),
  elapsedIsLive: z.boolean(),
  plannedArrivalAt: z.string(),
  route: RouteViewSchema,
  position: BottlePositionSchema,
  // Null until the sea ends the journey; then the persisted loss/sinking record.
  outcome: OutcomeSchema.nullable(),
  visibility: OutcomeVisibilitySchema.nullable(),
  // Storm windows around now, in the sender's account nights, only while at sea; empty
  // otherwise. Absolute instants, always inside a night of the account's own zone.
  storms: z.array(StormWindowSchema),
  publicListing: PublicListingSchema.nullable(),
  letter: z.object({ text: z.string(), font: LetterFontSchema, characters: z.number().int() }),
  // True when the letter was removed after an accepted report: the text above is empty.
  removed: z.boolean().optional(),
  events: z.array(JourneyEventSchema),
  // Storm nights this journey has sailed through so far (passport only).
  stormsWeathered: z.number().int().nonnegative(),
  serverTime: z.string(),
});
export type SentBottleDto = z.infer<typeof SentBottleSchema>;

export const SentBottleSummarySchema = SentBottleSchema.omit({
  letter: true,
  events: true,
  stormsWeathered: true,
});
export type SentBottleSummaryDto = z.infer<typeof SentBottleSummarySchema>;

export const ReleaseResponseSchema = z.object({ bottle: SentBottleSchema });

// ---------- recipient shore (only after committed arrival) ----------
export const ShoreBottleSchema = z.object({
  id: IdSchema,
  state: z.enum(['delivered', 'opened']),
  sender: z.object({ id: IdSchema, displayName: z.string() }),
  originShore: z.object({ id: IdSchema, name: z.string() }),
  releasedAt: z.string(),
  deliveredAt: z.string(),
  openedAt: z.string().nullable(),
  journeyDurationMs: z.number().int(),
});
export type ShoreBottleDto = z.infer<typeof ShoreBottleSchema>;

// The active shore: only bottles that have landed and are still sealed. Opening moves a bottle
// out of the shore into the received archive below; nothing is deleted.
export const ShoreResponseSchema = z.object({
  shore: ShoreSchema.nullable(),
  bottles: z.array(ShoreBottleSchema),
});
export type ShoreResponse = z.infer<typeof ShoreResponseSchema>;

// A letter in the reader's own archive (Letters → Received). Two ways in: it arrived on their
// shore and they opened it (`shore`), or they found it adrift in the public ocean and opened it
// there (`public`). A found bottle deliberately carries **no sender and no origin shore**: the
// public ocean never attributes a letter, and sender attribution in public discovery is still an
// open decision (spec D03). Nothing else about the journey is exposed either.
export const ReceivedLetterSchema = z.object({
  id: IdSchema,
  source: z.enum(['shore', 'public']),
  // A recipient or finder sees delivered, opened or lost; a sender reading their own letter
  // (GET /bottles/sent/:id/letter) may also see it at sea or cancelled.
  state: z.enum(['at_sea', 'delivered', 'opened', 'lost', 'cancelled']),
  sender: z.object({ id: IdSchema, displayName: z.string() }).nullable(),
  originShore: z.object({ id: IdSchema, name: z.string() }).nullable(),
  releasedAt: z.string(),
  // Null for a bottle found adrift: it never reached a shore.
  deliveredAt: z.string().nullable(),
  openedAt: z.string().nullable(),
  journeyDurationMs: z.number().int(),
});
export type ReceivedLetterDto = z.infer<typeof ReceivedLetterSchema>;

// Letters the user has opened, newest first (Letters → Received).
export const ReceivedLettersResponseSchema = z.object({ letters: z.array(ReceivedLetterSchema) });
export type ReceivedLettersResponse = z.infer<typeof ReceivedLettersResponseSchema>;

export const OpenedLetterSchema = z.object({
  bottle: ReceivedLetterSchema,
  letter: z.object({ text: z.string(), font: LetterFontSchema, characters: z.number().int() }),
  aging: AgingProfileSchema,
  // A finder's one-time reading: when the server stops serving it again (null for any other
  // reader — recipients and senders keep their letters).
  readingExpiresAt: z.string().nullable().optional(),
});
export type OpenedLetterDto = z.infer<typeof OpenedLetterSchema>;

// ---------- public ocean ----------
// The public projection of a bottle adrift (spec §10.3: "deliberately more limited than the
// private passport"). Exactly these fields and nothing else: no letter, no sender name, no
// recipient, no destination, no route — only that a bottle is drifting here since this moment.
// `mine` is computed per caller on the server so a sender can recognise their own bottle.
export const PublicBottleSchema = z
  .object({
    id: IdSchema,
    reason: z.literal('adrift'),
    lostAt: z.string(),
    position: z.object({ geo: GeoPointSchema }),
    mine: z.boolean(),
    // Listed until this moment (72 hours from the loss); opening is refused from then on.
    expiresAt: z.string(),
  })
  .strict();
export type PublicBottleDto = z.infer<typeof PublicBottleSchema>;

export const PublicOceanResponseSchema = z.object({
  bottles: z.array(PublicBottleSchema),
  serverTime: z.string(),
});
export type PublicOceanResponse = z.infer<typeof PublicOceanResponseSchema>;

// Opening a bottle found adrift: one server-owned action that grants the finder access to the
// letter and takes the bottle off the public map for everyone. The response is the ordinary
// opened-letter payload, so the finder reads it in the same reader as any other letter.
export const PublicOpenResponseSchema = OpenedLetterSchema;
export type PublicOpenResponse = z.infer<typeof PublicOpenResponseSchema>;

// ---------- notifications ----------
// What an inbox row is about. The four approved events plus the two older sender events that
// already exist in history (a cancelled delivery, a drifting bottle someone opened).
export const NOTIFICATION_KINDS = [
  'received_arrived',
  'sent_arrived',
  'sent_adrift',
  'sent_sunk',
  'sent_found',
  'sent_expired',
  'sent_cancelled',
  'moderation_violation',
  'moderation_suspended',
  'moderation_banned',
  'moderation_appeal_accepted',
  'moderation_appeal_rejected',
  'other',
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NotificationSchema = z.object({
  id: IdSchema,
  type: z.enum(['bottle_arrived', 'journey_event', 'moderation']),
  kind: NotificationKindSchema,
  bottleId: IdSchema.nullable(),
  message: z.string(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type NotificationDto = z.infer<typeof NotificationSchema>;

// ---------- dev ----------
export const DevAdvanceRequestSchema = z.object({
  ms: z
    .number()
    .int()
    .positive()
    .max(1000 * 60 * 60 * 24 * 365),
});
export const DevArriveRequestSchema = z.object({ bottleId: IdSchema });
// Development-only outcome control: ends one of the caller's own at-sea journeys now, through the
// same server path an automatic hazard engine would use once its policy values are approved.
export const DevLoseRequestSchema = z.object({
  bottleId: IdSchema,
  reason: z.enum(['adrift', 'sunk']),
});
export const DevStatusSchema = z.object({
  devMode: z.boolean(),
  serverTime: z.string(),
  clockOffsetMs: z.number().int(),
  msPerChartUnit: z.number().int(),
});
export type DevStatus = z.infer<typeof DevStatusSchema>;

// ---------- errors ----------
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------- reporting, moderation, appeals (spec §16) ----------
export const REPORT_REASONS = [
  'harassment',
  'hate',
  'sexual',
  'violence',
  'self_harm',
  'spam',
  'other',
] as const;
export const ReportReasonSchema = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof ReportReasonSchema>;

// A reader reporting the letter in front of them. `hide` takes the letter out of the reporter's
// own reads at once; nothing else changes until a case is decided.
export const ReportRequestSchema = z.object({
  bottleId: IdSchema,
  reason: ReportReasonSchema,
  explanation: z.string().trim().max(1000).optional(),
  hide: z.boolean().default(true),
});
export type ReportRequest = z.infer<typeof ReportRequestSchema>;

export const ReportResponseSchema = z.object({
  reportId: IdSchema,
  caseId: IdSchema,
  hidden: z.boolean(),
  // The same reader reporting the same letter again changes nothing.
  alreadyReported: z.boolean(),
});
export type ReportResponse = z.infer<typeof ReportResponseSchema>;

export const CASE_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export const CaseStatusSchema = z.enum(CASE_STATUSES);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

export const AI_VERDICTS = ['accept', 'reject', 'uncertain'] as const;
export const AiVerdictSchema = z.enum(AI_VERDICTS);
export type AiVerdict = z.infer<typeof AiVerdictSchema>;

// What the local model returns, validated before anything reads it. The model never decides
// anything itself: the backend validates this and performs every state change.
export const AiReviewOutputSchema = z.object({
  verdict: AiVerdictSchema,
  reason: z.string().trim().min(1).max(600),
  // Why it could not be sure — required to be meaningful when the verdict is `uncertain`.
  uncertainty: z.string().trim().max(600).nullable().optional(),
  language: z.string().trim().max(40).nullable().optional(),
  // An English rendering of the reported text, shown beside the original, never instead of it.
  translation: z.string().trim().max(4000).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});
export type AiReviewOutput = z.infer<typeof AiReviewOutputSchema>;

export const AiReviewSchema = z.object({
  status: z.enum(['queued', 'running', 'done', 'failed']),
  verdict: AiVerdictSchema.nullable(),
  reason: z.string().nullable(),
  uncertainty: z.string().nullable(),
  translation: z.string().nullable(),
  language: z.string().nullable(),
  model: z.string().nullable(),
  attempts: z.number().int(),
  completedAt: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type AiReviewDto = z.infer<typeof AiReviewSchema>;

export const PersonSchema = z.object({
  id: IdSchema,
  username: z.string(),
  displayName: z.string(),
});
export type PersonDto = z.infer<typeof PersonSchema>;

export const ModerationDecisionSchema = z.object({
  outcome: z.enum(['accepted', 'rejected']),
  // Who decided: an admin (named) or the model under automatic decisions.
  by: z.enum(['admin', 'ai']),
  admin: PersonSchema.nullable(),
  at: z.string(),
  reason: z.string().nullable(),
});
export type ModerationDecisionDto = z.infer<typeof ModerationDecisionSchema>;

export const LetterReportSchema = z.object({
  id: IdSchema,
  reason: ReportReasonSchema,
  explanation: z.string().nullable(),
  // Where the reporter read it: on their own shore, or as a finder in the public ocean.
  context: z.enum(['shore', 'public']),
  hidden: z.boolean(),
  createdAt: z.string(),
  reporter: PersonSchema,
});
export type LetterReportDto = z.infer<typeof LetterReportSchema>;

export const AdminCaseSummarySchema = z.object({
  id: IdSchema,
  status: CaseStatusSchema,
  bottleId: IdSchema,
  context: z.enum(['shore', 'public']),
  sender: PersonSchema,
  intendedRecipient: PersonSchema,
  reportCount: z.number().int(),
  reasons: z.array(ReportReasonSchema),
  firstReportedAt: z.string(),
  latestReportAt: z.string(),
  ai: AiReviewSchema,
  decision: ModerationDecisionSchema.nullable(),
  violationId: IdSchema.nullable(),
});
export type AdminCaseSummaryDto = z.infer<typeof AdminCaseSummarySchema>;

export const AdminCaseDetailSchema = AdminCaseSummarySchema.extend({
  // The protected evidence: the letter exactly as it read when it was first reported. `text`
  // is empty and `redactedAt` is set once a retention run has cleared a finally settled case.
  letter: z.object({
    text: z.string(),
    font: LetterFontSchema,
    characters: z.number().int(),
    redactedAt: z.string().nullable(),
  }),
  releasedAt: z.string(),
  reports: z.array(LetterReportSchema),
  appeal: z
    .object({
      id: IdSchema,
      status: z.enum(['pending', 'accepted', 'rejected']),
      text: z.string(),
      createdAt: z.string(),
    })
    .nullable(),
  // Where this case stands in the seven-day evidence retention calculation, so an
  // administrator can see why evidence is still here — or why it is about to go.
  retention: z.object({
    // The instant nothing could need the evidence any more; null while something still can.
    finalAt: z.string().nullable(),
    redactableAt: z.string().nullable(),
    // Why it is being kept: 'notice_unresolved', 'appeal_pending', 'legal_hold', …
    hold: z.string().nullable(),
  }),
  // A documented legal or immediate child-safety hold, if one was placed.
  hold: z
    .object({
      reason: z.enum(['legal', 'child_safety']),
      note: z.string(),
      placedAt: z.string(),
      placedBy: PersonSchema.nullable(),
      releasedAt: z.string().nullable(),
    })
    .nullable(),
  // The violation this case produced, if it was upheld.
  violation: z
    .object({
      id: IdSchema,
      severity: z.enum(['standard', 'critical']),
      appealAvailable: z.boolean(),
      appealWaivedAt: z.string().nullable(),
      noticePresentedAt: z.string().nullable(),
    })
    .nullable(),
  // SHA-256 of the evidence exactly as shown. A decision must echo it back, so a screen left
  // open while the case changed cannot decide something the administrator did not see.
  evidenceDigest: z.string(),
  // What upholding this case would do to the sender's standing, computed by the server from
  // the violations currently in force (audit FE-009).
  consequence: z.object({
    violationsInForce: z.number().int().nonnegative(),
    ifUpheld: z.enum(['warning', 'suspension', 'ban']),
  }),
  // The viewing administrator is the sender, the recipient or a reporter on this case, and so
  // may not decide it, its appeal or its critical classification (audit SEC-010).
  recused: z.boolean(),
});
export type AdminCaseDetailDto = z.infer<typeof AdminCaseDetailSchema>;

// One row of the moderation audit trail, as an administrator reads it (audit SEC-011).
export const AuditEntrySchema = z.object({
  id: IdSchema,
  action: z.string(),
  caseId: IdSchema.nullable(),
  violationId: IdSchema.nullable(),
  appealId: IdSchema.nullable(),
  subjectUserId: IdSchema.nullable(),
  actorUserId: IdSchema.nullable(),
  actorRole: z.enum(['admin', 'developer', 'member', 'system']),
  reason: z.string().nullable(),
  detail: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEntryDto = z.infer<typeof AuditEntrySchema>;

export const AdminAppealSchema = z.object({
  id: IdSchema,
  status: z.enum(['pending', 'accepted', 'rejected']),
  text: z.string(),
  createdAt: z.string(),
  appellant: PersonSchema,
  violation: z.object({
    id: IdSchema,
    category: ReportReasonSchema,
    decidedAt: z.string(),
    revokedAt: z.string().nullable(),
  }),
  case: AdminCaseDetailSchema,
  decision: z
    .object({
      outcome: z.enum(['accepted', 'rejected']),
      admin: PersonSchema,
      at: z.string(),
      reason: z.string().nullable(),
    })
    .nullable(),
});
export type AdminAppealDto = z.infer<typeof AdminAppealSchema>;

export const DecisionRequestSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

const EvidenceDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
// Deciding a report: the digest of the evidence the administrator was shown (see
// AdminCaseDetailSchema.evidenceDigest). Upholding also requires a reason; the server enforces it.
export const CaseDecisionRequestSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
  evidenceDigest: EvidenceDigestSchema,
});
export type CaseDecisionRequest = z.infer<typeof CaseDecisionRequestSchema>;

// ---------- the sender's side: violations, standing, appeals ----------
// Nothing here ever names or hints at a reporter.
export const ViolationNoticeSchema = z.object({
  id: IdSchema,
  ordinal: z.number().int(),
  category: ReportReasonSchema,
  decidedAt: z.string(),
  revokedAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  // `critical` is a confirmed child-safety violation, which bans immediately rather than
  // walking the warning ladder. It carries the same single appeal as any other decision.
  severity: z.enum(['standard', 'critical']),
  bottle: z.object({ id: IdSchema, recipientDisplayName: z.string(), releasedAt: z.string() }),
  appeal: z
    .object({
      id: IdSchema,
      status: z.enum(['pending', 'accepted', 'rejected']),
      text: z.string(),
      createdAt: z.string(),
      decidedAt: z.string().nullable(),
    })
    .nullable(),
  // The single appeal opportunity. `appealAvailable` is the server's answer to "may this
  // person still appeal this decision?" -- false once they have appealed, explicitly waived,
  // or the violation was revoked. Closing or reloading SeaYou changes none of it.
  appealAvailable: z.boolean(),
  appealWaivedAt: z.string().nullable(),
  noticePresentedAt: z.string().nullable(),
});
export type ViolationNoticeDto = z.infer<typeof ViolationNoticeSchema>;

export const ACCOUNT_STANDINGS = ['good', 'warned', 'suspended', 'banned'] as const;
export const AccountStandingSchema = z.object({
  standing: z.enum(ACCOUNT_STANDINGS),
  // Set while suspended: the elapsed-time instant the suspension ends.
  suspendedUntil: z.string().nullable(),
  violationsInForce: z.number().int(),
  // A first accepted violation the account has not acknowledged yet: shown once, on entry.
  pendingWarning: ViolationNoticeSchema.nullable(),
  // The decision notice still waiting to be resolved: the oldest upheld violation that has
  // been neither appealed nor explicitly waived. It comes back on every eligible visit until
  // the sender chooses, so leaving without choosing costs them nothing.
  pendingDecision: ViolationNoticeSchema.nullable(),
  violations: z.array(ViolationNoticeSchema),
});
export type AccountStandingDto = z.infer<typeof AccountStandingSchema>;

export const AppealRequestSchema = z.object({
  violationId: IdSchema,
  text: z.string().trim().min(1).max(2000),
});
export type AppealRequest = z.infer<typeof AppealRequestSchema>;

// Explicitly giving up the appeal. The client sends this only after the second confirmation,
// and the server treats it as permanent -- so it is deliberately its own request, never a
// side effect of reading or dismissing the notice.
export const WaiveAppealRequestSchema = z.object({ violationId: IdSchema });
export type WaiveAppealRequest = z.infer<typeof WaiveAppealRequestSchema>;

// The exact words the second confirmation must use, kept here so the API tests and the UI
// cannot drift apart.
export const APPEAL_WAIVER_CONFIRMATION =
  'If you continue, you will permanently lose the option to appeal this decision.';
export const APPEAL_ACTION_APPEAL = 'Appeal decision';
export const APPEAL_ACTION_CONTINUE = 'Continue without appealing';
export const APPEAL_ACTION_GO_BACK = 'Go back';
export const APPEAL_ACTION_SKIP = 'Skip appeal';

// A confirmed critical child-safety decision. The reason is mandatory: there is no path that
// bans an account this way without an administrator writing down why.
export const CriticalDecisionRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  classification: z.literal('critical_child_safety'),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CriticalDecisionRequest = z.infer<typeof CriticalDecisionRequestSchema>;

// A documented legal or immediate child-safety reason to keep a case's evidence beyond the
// ordinary seven days, and the release that returns it to the normal calculation.
export const HoldRequestSchema = z.object({
  reason: z.enum(['legal', 'child_safety']),
  note: z.string().trim().min(1).max(1000),
});
export type HoldRequest = z.infer<typeof HoldRequestSchema>;
