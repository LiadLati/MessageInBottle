import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => Promise<void>;
}

// Small polling-capable loader; a data library is deferred until the app has more screens.
//
// Polling stops while the tab is hidden and catches up once when it is shown again: an idle
// background tab otherwise costs ~26,000 requests a day for data that changes over hours
// (audit FE-014).
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[],
  pollMs?: number,
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });

  const reload = useCallback(async () => {
    try {
      setData(await loaderRef.current());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  // Callers that must reset on a dependency change remount with a `key`.
  useEffect(() => {
    void reload();
    if (!pollMs) return;
    let missed = false;
    const id = setInterval(() => {
      if (document.hidden) missed = true;
      else void reload();
    }, pollMs);
    const onVisibility = () => {
      if (!document.hidden && missed) {
        missed = false;
        void reload();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, pollMs, ...deps]);

  return { data, error, loading, reload };
}
