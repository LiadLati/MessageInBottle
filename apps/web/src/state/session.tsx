import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { MeResponse } from '@mib/shared';
import { api, setAuthToken } from '../api/client.js';

const STORAGE_KEY = 'mib.session.token';

interface SessionState {
  user: MeResponse | null;
  loading: boolean;
  login: (username: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
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

  const login = useCallback(async (username: string) => {
    const session = await api.devLogin(username);
    setAuthToken(session.token);
    storeToken(session.token);
    setUser(session.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setAuthToken(null);
      storeToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, logout, refresh }),
    [user, loading, login, logout, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
