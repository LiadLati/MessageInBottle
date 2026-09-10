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
  const res = await fetch(`/api${path}`, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
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
  devLogin: (username: string) => request<SessionResponse>('POST', '/auth/dev-login', { username }),
  me: () => request<MeResponse>('GET', '/auth/me'),
  logout: () => request<void>('POST', '/auth/logout'),
  chart: () => request<ChartResponse>('GET', '/chart'),
  setMyShore: (shoreId: string) => request<void>('PUT', '/chart/my-shore', { shoreId }),
  friends: () => request<FriendsResponse>('GET', '/friends'),
  sendFriendRequest: (username: string) => request<void>('POST', '/friends/requests', { username }),
  acceptFriendRequest: (id: string) => request<void>('POST', `/friends/requests/${id}/accept`),
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
};
