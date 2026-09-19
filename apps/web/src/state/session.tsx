import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { MeResponse, SessionResponse } from '@mib/shared';
import { api, setAuthToken } from '../api/client.js';

const STORAGE_KEY = 'mib.session.token';
// Client-side keys that belong to the signed-in person and must not survive a sign-out.
const PER_USER_KEYS = ['mib.draft'];

interface SessionState {
  user: MeResponse | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
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

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(() => readStoredToken() !== null);

  const refresh = useCallback(async () => {
    try {
      setUser(await api.me());
    } catch {
      setAuthToken(null);
      storeToken(null);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    const token = readStoredToken();
    if (!token) return;
    setAuthToken(token);
    void Promise.resolve()
      .then(refresh)
      .finally(() => setLoading(false));
  }, [refresh]);

  const start = useCallback((session: SessionResponse) => {
    setAuthToken(session.token);
    storeToken(session.token);
    setUser(session.user);
  }, []);

  const login = useCallback(
    async (username: string, password: string) => start(await api.login(username, password)),
    [start],
  );
  const register = useCallback(
    async (username: string, email: string, password: string) =>
      start(await api.register(username, email, password)),
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
      setAuthToken(null);
      storeToken(null);
      for (const key of PER_USER_KEYS) {
        try {
          sessionStorage.removeItem(key);
        } catch {
          /* ignore */
        }
      }
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, register, logout, refresh, setUser }),
    [user, loading, login, register, logout, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
