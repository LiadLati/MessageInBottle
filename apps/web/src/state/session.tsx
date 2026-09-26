import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { MeResponse, PolicyAcceptanceRequest, SessionResponse } from '@mib/shared';
import { ApiError, api, onSessionEnded, setAuthToken } from '../api/client.js';

export const SESSION_ENDED_NOTICE =
  'You were signed out because this session ended — for example after a password reset or signing out on another device. Sign in again to continue.';

const STORAGE_KEY = 'mib.session.token';
// Client-side keys that belong to the signed-in person and must not survive a sign-out: the
// unsent letter (session storage) and the account's time zone (local storage). The Privacy
// Policy says both are removed on sign-out (audit FE-010 / SEC-015).
export const PER_USER_SESSION_KEYS = ['mib.draft'] as const;
export const PER_USER_LOCAL_KEYS = ['mib.accountTimeZone'] as const;

export function clearPerUserStorage(): void {
  for (const sessionKey of PER_USER_SESSION_KEYS) {
    try {
      sessionStorage.removeItem(sessionKey);
    } catch {
      /* storage unavailable */
    }
  }
  for (const localKey of PER_USER_LOCAL_KEYS) {
    try {
      localStorage.removeItem(localKey);
    } catch {
      /* storage unavailable */
    }
  }
}

interface SessionState {
  user: MeResponse | null;
  loading: boolean;
  /** Restoring a stored session is waiting for the server to become reachable. */
  reconnecting: boolean;
  /** Why the sign-in screen is showing, when the session ended without the person's say-so. */
  endedNotice: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (
    username: string,
    email: string,
    password: string,
    policies: PolicyAcceptanceRequest,
  ) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Replace the signed-in user with a fresher copy from the server (e.g. after a zone sync). */
  setUser: (user: MeResponse) => void;
}

const SessionContext = createContext<SessionState | null>(null);

function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(STORAGE_KEY, token);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: session lives in memory only */
  }
}

// How long to wait before asking again when the server could not be reached at startup.
export const RECONNECT_MS = 5_000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(() => readStoredToken() !== null);
  // Set when the server could not be reached while restoring a stored session: the token is
  // kept and the restore retried, rather than signing the person out (audit FE-003).
  const [reconnecting, setReconnecting] = useState(false);
  // Why the person is looking at the sign-in screen, when it was not their own choice.
  const [endedNotice, setEndedNotice] = useState<string | null>(null);

  const end = useCallback((notice: string | null) => {
    setAuthToken(null);
    storeToken(null);
    clearPerUserStorage();
    setUser(null);
    setEndedNotice(notice);
  }, []);

  // Only an answer from the server that this token is not valid ends the session. A network
  // failure, a proxy error or a server that is restarting keeps it.
  const refresh = useCallback(async (): Promise<'ok' | 'ended' | 'unreachable'> => {
    try {
      setUser(await api.me());
      setReconnecting(false);
      return 'ok';
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        end(SESSION_ENDED_NOTICE);
        return 'ended';
      }
      setReconnecting(true);
      return 'unreachable';
    }
  }, [end]);

  useEffect(() => {
    const token = readStoredToken();
    if (!token) return;
    setAuthToken(token);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      const outcome = await refresh();
      if (!alive) return;
      if (outcome === 'unreachable') timer = setTimeout(() => void attempt(), RECONNECT_MS);
      else setLoading(false);
    };
    void attempt();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  // The server said this browser's session is over (audit FE-002): back to sign-in, with a
  // sentence saying why, instead of a shell of "authentication required" errors.
  useEffect(() => {
    onSessionEnded(() => end(SESSION_ENDED_NOTICE));
    return () => onSessionEnded(null);
  }, [end]);

  const start = useCallback((session: SessionResponse) => {
    setAuthToken(session.token);
    storeToken(session.token);
    setEndedNotice(null);
    setUser(session.user);
  }, []);

  const login = useCallback(
    async (username: string, password: string) => start(await api.login(username, password)),
    [start],
  );
  const register = useCallback(
    async (username: string, email: string, password: string, policies: PolicyAcceptanceRequest) =>
      start(await api.register(username, email, password, policies)),
    [start],
  );

  // Safe sign-out: the server session is revoked, and whatever the request outcome the token
  // and any per-user client state are gone from this browser.
  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* the token is dropped regardless */
    } finally {
      end(null);
    }
  }, [end]);

  const refreshUser = useCallback(async () => {
    await refresh();
  }, [refresh]);
  const value = useMemo(
    () => ({
      user,
      loading,
      reconnecting,
      endedNotice,
      login,
      register,
      logout,
      refresh: refreshUser,
      setUser,
    }),
    [user, loading, reconnecting, endedNotice, login, register, logout, refreshUser],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
