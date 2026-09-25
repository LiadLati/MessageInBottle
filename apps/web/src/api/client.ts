import { z, type ZodType } from 'zod';
import {
  AccountDeletedResponseSchema,
  AccountWeatherSchema,
  AccountPoliciesSchema,
  AccountStandingSchema,
  AdminAppealSchema,
  AdminCaseDetailSchema,
  AdminCaseSummarySchema,
  ChartResponseSchema,
  DevStatusSchema,
  FriendsResponseSchema,
  MeResponseSchema,
  BlockedUsersResponseSchema,
  NotificationsPageSchema,
  OpenedLetterSchema,
  OutcomeVisibilitySchema,
  PublicOceanResponseSchema,
  ReceivedLettersResponseSchema,
  ReleasePreviewResponseSchema,
  ReleaseResponseSchema,
  ReportResponseSchema,
  SentBottleSchema,
  SentBottleSummarySchema,
  SessionResponseSchema,
  ShoreResponseSchema,
  ViolationNoticeSchema,
  type LetterFont,
  type PolicyAcceptanceRequest,
  type ReportReason,
} from '@mib/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

// The API could not be spoken to at all: the request never completed, or something in front of
// the API answered with a server error that is not an API response (a dev proxy whose upstream
// is down answers exactly this way: 5xx with an empty body). Kept distinct from a real server
// error so the UI can say "the server is not running" instead of blaming the request.
// Reported by the API. `mail` and `devMode` are present only in development builds.
export interface HealthResponse {
  ok: boolean;
  serverTime: string;
  devMode?: boolean;
  mail?: { provider: string; delivers: boolean };
}

export const UNREACHABLE = 'unreachable';
export const UNREACHABLE_MESSAGE =
  'Cannot reach the SeaYou server. Check that the API is running, then try again.';

// A 200 whose body is not what this version of the app understands (a version-skewed API, a
// proxy that rewrote the body) becomes an ordinary, recoverable error instead of a crash deep
// inside a screen (audit QA-007).
export const INVALID_RESPONSE = 'invalid_response';
export const INVALID_RESPONSE_MESSAGE =
  'SeaYou received a reply it could not read. Reload the page to get the latest version.';

let authToken: string | null = null;
export function setAuthToken(token: string | null) {
  authToken = token;
}

// Called once when the server says the session this browser holds is no longer valid (signed
// out elsewhere, password reset, account deleted, expired): the session state drops to the
// sign-in screen instead of leaving a shell full of "authentication required" (audit FE-002).
let sessionEnded: (() => void) | null = null;
export function onSessionEnded(handler: (() => void) | null) {
  sessionEnded = handler;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  schema?: ZodType<T>,
): Promise<T> {
  const sentToken = authToken;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch (cause) {
    // Network-level failure: no server, DNS, TLS, or the request was cut off.
    throw new ApiError(0, UNREACHABLE, UNREACHABLE_MESSAGE, cause);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  // An error body is not guaranteed to be JSON (a proxy or load balancer may answer with plain
  // text or HTML), so parsing must never turn a useful status into a parse exception.
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
    // The API always shapes its own failures as {error:{code,message}}. A 5xx without one did
    // not come from the API: nothing is listening behind the proxy.
    if (!err && res.status >= 500) throw new ApiError(res.status, UNREACHABLE, UNREACHABLE_MESSAGE);
    if (res.status === 401 && err?.code === 'unauthorized' && sentToken && sentToken === authToken)
      sessionEnded?.();
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? res.statusText,
      err?.details,
    );
  }
  if (!schema) return json as T;
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError(res.status, INVALID_RESPONSE, INVALID_RESPONSE_MESSAGE);
  return parsed.data;
}

const Ok = z.object({ ok: z.boolean() });
const BottlesList = z.object({ bottles: z.array(SentBottleSummarySchema) });
const OneBottle = z.object({ bottle: SentBottleSchema });
const Visibility = z.object({ visibility: OutcomeVisibilitySchema });
const Reading = z.object({ reading: OpenedLetterSchema.nullable() });
const Cases = z.object({ cases: z.array(AdminCaseSummarySchema) });
const OneCase = z.object({ case: AdminCaseDetailSchema });
const DecidedCase = z.object({ case: AdminCaseDetailSchema, changed: z.boolean() });
const Appeals = z.object({ appeals: z.array(AdminAppealSchema) });
const DecidedAppeal = z.object({ appeal: AdminAppealSchema, changed: z.boolean() });
const Outbox = z.object({
  provider: z.string(),
  messages: z.array(
    z.object({
      id: z.number(),
      to: z.string(),
      subject: z.string(),
      text: z.string(),
      sentAt: z.string(),
    }),
  ),
});

export const api = {
  health: () => request<HealthResponse>('GET', '/health'),
  register: (
    username: string,
    email: string,
    password: string,
    policies: PolicyAcceptanceRequest,
  ) =>
    request(
      'POST',
      '/auth/register',
      { username, email, password, policies },
      SessionResponseSchema,
    ),
  // Terms, guidelines and privacy: the standing of the signed-in account against the current
  // versions, and accepting them from the "updated terms" screen.
  policyStanding: () => request('GET', '/policies/me/standing', undefined, AccountPoliciesSchema),
  acceptPolicies: (policies: PolicyAcceptanceRequest) =>
    request('POST', '/policies/accept', policies, AccountPoliciesSchema),
  // Settings → Delete account. Permanent, and refused without the password and the confirmation.
  deleteAccount: (password: string) =>
    request('POST', '/account/delete', { password, confirm: true }, AccountDeletedResponseSchema),
  forgotPassword: (email: string) => request('POST', '/auth/password/forgot', { email }, Ok),
  resetPassword: (token: string, password: string) =>
    request<void>('POST', '/auth/password/reset', { token, password }),
  login: (username: string, password: string) =>
    request('POST', '/auth/login', { username, password }, SessionResponseSchema),
  me: () => request('GET', '/auth/me', undefined, MeResponseSchema),
  logout: () => request<void>('POST', '/auth/logout'),
  chart: () => request('GET', '/chart', undefined, ChartResponseSchema),
  setMyShore: (shoreId: string) => request<void>('PUT', '/chart/my-shore', { shoreId }),
  friends: () => request('GET', '/friends', undefined, FriendsResponseSchema),
  sendFriendRequest: (username: string) => request<void>('POST', '/friends/requests', { username }),
  acceptFriendRequest: (id: string) => request<void>('POST', `/friends/requests/${id}/accept`),
  denyFriendRequest: (id: string) => request<void>('POST', `/friends/requests/${id}/deny`),
  blockUser: (username: string) => request<void>('POST', '/friends/blocks', { username }),
  blockedUsers: () => request('GET', '/friends/blocks', undefined, BlockedUsersResponseSchema),
  // Undoes a block only: nothing removed, cancelled or hidden comes back, and no friendship.
  unblockUser: (username: string) =>
    request<void>('DELETE', `/friends/blocks/${encodeURIComponent(username)}`),
  // A finder's block of an anonymous writer is named, and undone, by the bottle they found.
  unblockFoundWriter: (bottleId: string) =>
    request<void>('DELETE', `/friends/blocks/found/${encodeURIComponent(bottleId)}`),
  sentBottles: () => request('GET', '/bottles/sent', undefined, BottlesList),
  sentBottle: (id: string) => request('GET', `/bottles/sent/${id}`, undefined, OneBottle),
  // Private-map visibility of a terminal marker (the sender's own record, per account).
  markOutcomeSeen: (id: string) =>
    request('POST', `/bottles/sent/${id}/seen`, undefined, Visibility),
  acknowledgeOutcome: (id: string) =>
    request('POST', `/bottles/sent/${id}/acknowledge`, undefined, Visibility),
  // The public ocean: only the strict public projection ever comes back from here.
  publicOcean: () => request('GET', '/ocean/public', undefined, PublicOceanResponseSchema),
  // One server-owned action: it grants the caller the letter and takes the bottle off the
  // public map for everyone. 409 `already_opened` means somebody else was first.
  openPublicBottle: (id: string) =>
    request('POST', `/ocean/public/${id}/open`, undefined, OpenedLetterSchema),
  // The finder's still-open one-time reading (recovers a refresh); ending it is immediate.
  activeReading: () => request('GET', '/ocean/reading', undefined, Reading),
  closeReading: (id: string) => request<void>('POST', `/ocean/public/${id}/close`),
  // Blocks the writer from inside the finder's reading; the writer's identity never comes back.
  blockFoundWriter: (id: string) => request<void>('POST', `/ocean/public/${id}/block`),
  // The sender reading their own letter: a pure read that never claims the bottle.
  ownLetter: (id: string) =>
    request('GET', `/bottles/sent/${id}/letter`, undefined, OpenedLetterSchema),
  previewRelease: (recipientId: string) =>
    request('POST', '/bottles/preview', { recipientId }, ReleasePreviewResponseSchema),
  release: (input: {
    recipientId: string;
    text: string;
    font: LetterFont;
    idempotencyKey: string;
  }) =>
    request(
      'POST',
      '/bottles/release',
      { ...input, disclosureAcknowledged: true },
      ReleaseResponseSchema,
    ),
  myShore: () => request('GET', '/shore', undefined, ShoreResponseSchema),
  receivedLetters: () =>
    request('GET', '/shore/received', undefined, ReceivedLettersResponseSchema),
  openBottle: (id: string) =>
    request('POST', `/shore/bottles/${id}/open`, undefined, OpenedLetterSchema),
  readLetter: (id: string) =>
    request('GET', `/shore/bottles/${id}/letter`, undefined, OpenedLetterSchema),
  // Notification history, newest first, one page at a time. `before` is the previous page's
  // cursor; nothing is ever pruned from this history.
  notifications: (before?: string) =>
    request(
      'GET',
      before ? `/notifications?before=${encodeURIComponent(before)}` : '/notifications',
      undefined,
      NotificationsPageSchema,
    ),
  markNotificationsRead: () => request<void>('POST', '/notifications/read-all'),
  // The device's zone, reported after sign-in, on start, on resume and when it changes. The
  // server validates it; the latest one it accepts is the account's map clock.
  syncTimeZone: (timeZone: string) =>
    request('PUT', '/auth/time-zone', { timeZone }, MeResponseSchema),
  // The account's authoritative map clock and storm: the same answer on every device.
  accountWeather: () => request('GET', '/ocean/weather', undefined, AccountWeatherSchema),
  // Reporting and standing (spec §16). Reporting is one request from the reader; the sender's
  // standing, warning acknowledgement and appeals work even while suspended or banned.
  reportLetter: (input: {
    bottleId: string;
    reason: ReportReason;
    explanation?: string;
    hide: boolean;
  }) => request('POST', '/moderation/reports', input, ReportResponseSchema),
  standing: () => request('GET', '/moderation/standing', undefined, AccountStandingSchema),
  acknowledgeWarning: (violationId: string) =>
    request<void>('POST', `/moderation/violations/${violationId}/acknowledge`),
  submitAppeal: (violationId: string, text: string) =>
    request('POST', '/moderation/appeals', { violationId, text }, ViolationNoticeSchema),
  // Tells the server the decision notice is actually on screen. The server opens the appeal
  // from this, so a notice nobody saw is never treated as one they declined to appeal.
  presentDecision: (violationId: string) =>
    request(
      'POST',
      `/moderation/violations/${violationId}/presented`,
      undefined,
      ViolationNoticeSchema,
    ),
  // "Skip appeal", after the second confirmation. Permanent.
  waiveAppeal: (violationId: string) =>
    request('POST', '/moderation/appeals/waive', { violationId }, ViolationNoticeSchema),
  // Admin console. Every one of these is refused by the server unless the account's role says so.
  adminCases: (status: 'pending' | 'accepted' | 'rejected' | 'all') =>
    request('GET', `/admin/reports?status=${status}`, undefined, Cases),
  adminCase: (id: string) => request('GET', `/admin/reports/${id}`, undefined, OneCase),
  // Deciding echoes the digest of the evidence on screen, so a stale screen cannot decide a case
  // that changed after it was opened.
  adminDecideCase: (
    id: string,
    outcome: 'accept' | 'reject',
    reason: string,
    evidenceDigest: string,
  ) => request('POST', `/admin/reports/${id}/${outcome}`, { reason, evidenceDigest }, DecidedCase),
  // A confirmed critical child-safety violation: an immediate permanent ban. Admin only, and
  // the reason is mandatory on the server too.
  adminDecideCritical: (id: string, reason: string, evidenceDigest: string) =>
    request(
      'POST',
      `/admin/reports/${id}/critical`,
      { reason, classification: 'critical_child_safety', evidenceDigest },
      OneCase,
    ),
  adminPlaceHold: (id: string, reason: 'legal' | 'child_safety', note: string) =>
    request('POST', `/admin/reports/${id}/hold`, { reason, note }, OneCase),
  adminReleaseHold: (id: string) =>
    request('POST', `/admin/reports/${id}/hold/release`, undefined, OneCase),
  adminAppeals: (status: 'pending' | 'accepted' | 'rejected' | 'all') =>
    request('GET', `/admin/appeals?status=${status}`, undefined, Appeals),
  adminDecideAppeal: (id: string, outcome: 'accept' | 'reject', reason: string) =>
    request('POST', `/admin/appeals/${id}/${outcome}`, { reason }, DecidedAppeal),
  devStatus: () => request('GET', '/dev/status', undefined, DevStatusSchema),
  devAdvance: (ms: number) => request('POST', '/dev/advance', { ms }, DevStatusSchema),
  devArrive: (bottleId: string) => request('POST', '/dev/arrive', { bottleId }, DevStatusSchema),
  devLose: (bottleId: string, reason: 'adrift' | 'sunk') =>
    request('POST', '/dev/lose', { bottleId, reason }, DevStatusSchema),
  devOutbox: () => request('GET', '/dev/outbox', undefined, Outbox),
};
