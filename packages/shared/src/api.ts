import { z } from 'zod';
import { BOTTLE_STATES, JOURNEY_EVENT_TYPES } from './bottle-state.js';
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

// ---------- auth ----------
export const DevLoginRequestSchema = z.object({ username: UsernameSchema });
export const SessionResponseSchema = z.object({
  token: z.string(),
  user: z.object({
    id: IdSchema,
    username: z.string(),
    displayName: z.string(),
    shoreId: IdSchema.nullable(),
  }),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const MeResponseSchema = SessionResponseSchema.shape.user;
export type MeResponse = z.infer<typeof MeResponseSchema>;

// ---------- shores & chart ----------
export const ShoreSchema = z.object({
  id: IdSchema,
  name: z.string(),
  position: ChartPointSchema,
  capacity: z.number().int().nonnegative(),
});
export type ShoreDto = z.infer<typeof ShoreSchema>;

export const ChartNodeSchema = z.object({
  id: IdSchema,
  kind: z.enum(['shore', 'waypoint', 'island']),
  position: ChartPointSchema,
  shoreId: IdSchema.nullable(),
});
export const ChartEdgeSchema = z.object({ from: IdSchema, to: IdSchema });
export const ChartResponseSchema = z.object({
  graphVersion: z.number().int(),
  bounds: z.object({ width: z.number(), height: z.number() }),
  nodes: z.array(ChartNodeSchema),
  edges: z.array(ChartEdgeSchema),
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
  totalLength: z.number(),
  plannedDurationMs: z.number().int(),
});
export type RouteView = z.infer<typeof RouteViewSchema>;

export const ReleasePreviewResponseSchema = z.object({
  eligible: z.boolean(),
  rejection: z.enum(RELEASE_REJECTIONS).nullable(),
  originShore: ShoreSchema.nullable(),
  destinationShore: ShoreSchema.pick({ id: true, name: true, position: true }).nullable(),
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
  progress: z.number().min(0).max(1),
  asOf: z.string(),
});

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

export const ShoreResponseSchema = z.object({
  shore: ShoreSchema.nullable(),
  bottles: z.array(ShoreBottleSchema),
});
export type ShoreResponse = z.infer<typeof ShoreResponseSchema>;

export const OpenedLetterSchema = z.object({
  bottle: ShoreBottleSchema,
  letter: z.object({ text: z.string(), font: LetterFontSchema, characters: z.number().int() }),
  aging: AgingProfileSchema,
});
export type OpenedLetterDto = z.infer<typeof OpenedLetterSchema>;

// ---------- notifications ----------
export const NotificationSchema = z.object({
  id: IdSchema,
  type: z.enum(['bottle_arrived', 'journey_event']),
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
