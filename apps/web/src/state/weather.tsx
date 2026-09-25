import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DAYLIGHT_DEFAULTS,
  harbourTimeZone,
  isIanaTimeZone,
  phaseAt,
  type DayPhase,
} from '@mib/shared';
import { api } from '../api/client.js';
import { useSession } from './session.js';

// One clock and one timezone policy for all simulated weather — scheduling and display alike
// (docs/WEATHER_INTEGRATION_PLAN.md · "Clock and timezone policy"):
//
//   instant = real time, shifted by the persisted development-clock offset when the API reports
//             one, so dev time travel moves weather together with journeys;
//   zone    = the account's persisted IANA zone (spec §9.3): learned from the device, never GPS
//             and never coordinates, and re-sent to the server whenever the app starts or
//             resumes so the server counts the same nights this map is drawn in. Offline, the
//             last zone the account was known to have; before any account, the device's own;
//   phase   = the local hour in that zone against a configurable day window (07:00–19:00).
//
// The server schedules every storm and every risk decision in that same zone, so a daytime map
// never holds a bottle in a risk-bearing storm.
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

// The device's IANA zone (product decision 9), or null when the runtime gives nothing usable.
// Read again on every start and resume, so a phone that crossed a border follows it.
function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isIanaTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

// The last zone the account was known to have, so an offline start keeps yesterday's nights
// rather than silently switching to the device's. A convenience, never an authority.
const ZONE_KEY = 'mib.accountTimeZone';
function readStoredZone(): string | null {
  try {
    return localStorage.getItem(ZONE_KEY);
  } catch {
    return null;
  }
}
function storeZone(zone: string | null) {
  try {
    if (zone) localStorage.setItem(ZONE_KEY, zone);
    else localStorage.removeItem(ZONE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function WeatherProvider({ children }: { children: ReactNode }) {
  const [deviceZone, setDeviceZone] = useState<string | null>(() => browserTimeZone());
  // Development clock offset, learned once and refreshed with the dev panel's own polling.
  const [offsetMs, setOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [phaseOverride, setPhaseOverride] = useState<DayPhase | 'auto'>('auto');
  const [oceanStormOverride, setOceanStormOverride] = useState<WeatherOverride>('auto');
  const [shoreStormOverride, setShoreStormOverride] = useState<WeatherOverride>('auto');

  // The status endpoint needs a session, so the offset is re-read whenever the signed-in user
  // changes: a fresh sign-in must not spend its first tick on the real clock.
  const { user, setUser } = useSession();
  const userId = user?.id ?? null;
  const isDeveloper = user?.role === 'developer';
  // The account's zone is the authority for its nights. Until the server has heard from a
  // device, or while it cannot be reached, the last known zone stands in; before any account
  // at all, the device's own.
  const accountZone = user?.timeZone ?? null;
  // Without a usable device zone, the chosen harbour's nautical zone, then UTC. Only then is
  // the chart fetched for the harbour's longitude.
  const [harbourZone, setHarbourZone] = useState<string | null>(null);
  const shoreId = user?.shoreId ?? null;
  useEffect(() => {
    if (deviceZone || !shoreId) return;
    let alive = true;
    void api
      .chart()
      .then((c) => {
        const lng = c.shores.find((x) => x.id === shoreId)?.geo?.lng;
        if (alive) setHarbourZone(harbourTimeZone(lng));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [deviceZone, shoreId]);
  const timeZone = accountZone ?? readStoredZone() ?? deviceZone ?? harbourZone ?? 'UTC';
  useEffect(() => {
    if (accountZone) storeZone(accountZone);
  }, [accountZone]);

  // Tell the server the device's zone on every start and resume. A changed zone moves the
  // account's nights from now on — never the ones already sailed — and is a no-op otherwise.
  // Only a valid IANA name is ever sent; a device without one sends nothing.
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    const sync = () => {
      if (document.hidden) return;
      const now = browserTimeZone();
      if (now !== deviceZone) {
        setDeviceZone(now);
        return; // the effect re-runs with the new zone and sends it
      }
      if (!now || now === accountZone) return;
      void api
        .syncTimeZone(now)
        .then((me) => {
          if (alive) setUser(me);
        })
        .catch(() => {});
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
    };
  }, [userId, deviceZone, accountZone, setUser]);
  useEffect(() => {
    // Only a developer may read the dev clock; anyone else would get a 403 twice a minute (FE-021).
    if (!import.meta.env.DEV || !userId || !isDeveloper) return;
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
  }, [userId, isDeveloper]);

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
