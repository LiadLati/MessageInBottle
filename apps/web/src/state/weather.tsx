import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DAYLIGHT_DEFAULTS, phaseAt, type DayPhase } from '@mib/shared';
import { api } from '../api/client.js';
import { useSession } from './session.js';

// One clock and one timezone policy for all simulated weather — scheduling and display alike
// (docs/WEATHER_INTEGRATION_PLAN.md · "Clock and timezone policy"):
//
//   instant = real time, shifted by the persisted development-clock offset when the API reports
//             one, so dev time travel moves weather together with journeys;
//   zone    = the browser's own IANA zone, never GPS and never coordinates;
//   phase   = the local hour in that zone against a configurable day window (07:00–19:00).
//
// Authentication never uses this clock: sessions and reset tokens run on real wall-clock time
// on the server, so a development clock jump can land a bottle but never sign anyone out.

export type WeatherOverride = 'auto' | 'on' | 'off';

export interface WeatherState {
  phase: DayPhase;
  /** The instant weather is scheduled against, in ms. */
  nowMs: number;
  timeZone: string;
  /** Development-only previews. 'auto' means the real schedule decides. */
  phaseOverride: DayPhase | 'auto';
  oceanStormOverride: WeatherOverride;
  shoreStormOverride: WeatherOverride;
  setPhaseOverride: (v: DayPhase | 'auto') => void;
  setOceanStormOverride: (v: WeatherOverride) => void;
  setShoreStormOverride: (v: WeatherOverride) => void;
}

const WeatherContext = createContext<WeatherState | null>(null);

// Re-evaluated on this cadence; a boundary is never more than this late. Cheap: two integer
// comparisons and a formatter.
const TICK_MS = 30_000;

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function WeatherProvider({ children }: { children: ReactNode }) {
  const timeZone = useMemo(() => browserTimeZone(), []);
  // Development clock offset, learned once and refreshed with the dev panel's own polling.
  const [offsetMs, setOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [phaseOverride, setPhaseOverride] = useState<DayPhase | 'auto'>('auto');
  const [oceanStormOverride, setOceanStormOverride] = useState<WeatherOverride>('auto');
  const [shoreStormOverride, setShoreStormOverride] = useState<WeatherOverride>('auto');

  // The status endpoint needs a session, so the offset is re-read whenever the signed-in user
  // changes: a fresh sign-in must not spend its first tick on the real clock.
  const { user } = useSession();
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!import.meta.env.DEV || !userId) return;
    let alive = true;
    const read = () =>
      void api
        .devStatus()
        .then((s) => {
          if (alive && s.devMode) setOffsetMs(s.clockOffsetMs);
        })
        .catch(() => {});
    read();
    const id = setInterval(read, TICK_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [userId]);

  // Keep the instant fresh while the page is open, and re-read it immediately when a
  // backgrounded tab comes back — a tab restored after midnight must not stay on yesterday.
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    const id = setInterval(tick, TICK_MS);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  const instant = nowMs + offsetMs;
  const value = useMemo<WeatherState>(() => {
    const natural = phaseAt(instant, timeZone, DAYLIGHT_DEFAULTS);
    return {
      phase: phaseOverride === 'auto' ? natural : phaseOverride,
      nowMs: instant,
      timeZone,
      phaseOverride,
      oceanStormOverride,
      shoreStormOverride,
      setPhaseOverride,
      setOceanStormOverride,
      setShoreStormOverride,
    };
  }, [instant, timeZone, phaseOverride, oceanStormOverride, shoreStormOverride]);

  return <WeatherContext.Provider value={value}>{children}</WeatherContext.Provider>;
}

export function useWeather(): WeatherState {
  const ctx = useContext(WeatherContext);
  if (!ctx) throw new Error('useWeather outside WeatherProvider');
  return ctx;
}
