import type {
  ChartResponse,
  DevStatus,
  FriendsResponse,
  LetterFont,
  MeResponse,
  NotificationDto,
  OpenedLetterDto,
  ReleasePreviewResponse,
  SentBottleDto,
  SentBottleSummaryDto,
  SessionResponse,
  ShoreResponse,
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
  'Cannot reach the Message in a Bottle server. Check that the API is running, then try again.';

let authToken: string | null = null;
export function setAuthToken(token: string | null) {
  authToken = token;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? res.statusText,
      err?.details,
    );
  }
  return json as T;
}

export const api = {
  health: () => request<HealthResponse>('GET', '/health'),
  register: (username: string, email: string, password: string) =>
    request<SessionResponse>('POST', '/auth/register', { username, email, password }),
  forgotPassword: (email: string) =>
    request<{ ok: boolean }>('POST', '/auth/password/forgot', { email }),
  resetPassword: (token: string, password: string) =>
    request<void>('POST', '/auth/password/reset', { token, password }),
  login: (username: string, password: string) =>
    request<SessionResponse>('POST', '/auth/login', { username, password }),
  me: () => request<MeResponse>('GET', '/auth/me'),
  logout: () => request<void>('POST', '/auth/logout'),
  chart: () => request<ChartResponse>('GET', '/chart'),
  setMyShore: (shoreId: string) => request<void>('PUT', '/chart/my-shore', { shoreId }),
  friends: () => request<FriendsResponse>('GET', '/friends'),
  sendFriendRequest: (username: string) => request<void>('POST', '/friends/requests', { username }),
  acceptFriendRequest: (id: string) => request<void>('POST', `/friends/requests/${id}/accept`),
  denyFriendRequest: (id: string) => request<void>('POST', `/friends/requests/${id}/deny`),
  blockUser: (username: string) => request<void>('POST', '/friends/blocks', { username }),
  sentBottles: () => request<{ bottles: SentBottleSummaryDto[] }>('GET', '/bottles/sent'),
  sentBottle: (id: string) => request<{ bottle: SentBottleDto }>('GET', `/bottles/sent/${id}`),
  previewRelease: (recipientId: string) =>
    request<ReleasePreviewResponse>('POST', '/bottles/preview', { recipientId }),
  release: (input: {
    recipientId: string;
    text: string;
    font: LetterFont;
    idempotencyKey: string;
  }) =>
    request<{ bottle: SentBottleDto; replayed: boolean }>('POST', '/bottles/release', {
      ...input,
      disclosureAcknowledged: true,
    }),
  myShore: () => request<ShoreResponse>('GET', '/shore'),
  openBottle: (id: string) => request<OpenedLetterDto>('POST', `/shore/bottles/${id}/open`),
  readLetter: (id: string) => request<OpenedLetterDto>('GET', `/shore/bottles/${id}/letter`),
  notifications: () => request<{ notifications: NotificationDto[] }>('GET', '/notifications'),
  markNotificationsRead: () => request<void>('POST', '/notifications/read-all'),
  devStatus: () => request<DevStatus>('GET', '/dev/status'),
  devAdvance: (ms: number) => request<DevStatus>('POST', '/dev/advance', { ms }),
  devArrive: (bottleId: string) => request<DevStatus>('POST', '/dev/arrive', { bottleId }),
  devOutbox: () =>
    request<{
      provider: string;
      messages: Array<{ id: number; to: string; subject: string; text: string; sentAt: string }>;
    }>('GET', '/dev/outbox'),
};
