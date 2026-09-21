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
  events: z.array(JourneyEventSchema),
  serverTime: z.string(),
});
export type SentBottleDto = z.infer<typeof SentBottleSchema>;

export const SentBottleSummarySchema = SentBottleSchema.omit({ letter: true, events: true });
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
  state: z.enum(['delivered', 'opened', 'lost']),
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
  'other',
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NotificationSchema = z.object({
  id: IdSchema,
  type: z.enum(['bottle_arrived', 'journey_event']),
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
