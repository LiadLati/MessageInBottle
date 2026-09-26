import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DAYLIGHT_DEFAULTS,
  isIanaTimeZone,
  phaseAt,
  type AccountWeatherDto,
  type DayPhase,
} from '@mib/shared';
import { api } from '../api/client.js';
import { monotonicNow, sampleOf, serverNow, type ClockSample } from '../lib/serverClock.js';
import { useSession } from './session.js';

// One clock for the map's day and night and for its storm (risk policy v4, spec §9.3):
//
//   zone    = the account's authoritative IANA zone, as the server holds it: the latest valid
//             zone any of the account's devices reported and the server accepted; before any,
//             the harbour's zone; else UTC. This device reports its own zone after sign-in, on
//             start, on returning to the foreground and whenever it notices a change — never
//             GPS, never coordinates — and every device draws the server's answer, so a phone
//             and a desktop of the same account never disagree;
//   instant = the server's time: the `serverTime` of the latest weather answer, advanced by
//             monotonic elapsed time on this device and replaced by every fresh answer (every
//             poll and every return to the foreground). A wrong or changed device clock cannot
//             move the map (audit FE-R-003). The server's time already includes the development
//             clock offset, so dev time travel still moves weather with journeys. Before the
//             first answer only, the device clock (plus the dev offset) stands in;
//   phase   = the local hour in that zone against the day window (07:00–19:00);
//   storm   = the account's one storm, persisted by the server: shown only while it lasts and
//             only while the map is in night.
//
// Authentication never uses this clock: sessions and reset tokens run on real wall-clock time
// on the server, so a development clock jump can land a bottle but never sign anyone out.

export type WeatherOverride = 'auto' | 'on' | 'off';

export interface WeatherState {
  phase: DayPhase;
  /** The instant weather is scheduled against, in ms. */
  nowMs: number;
  timeZone: string;
  /** The account's storm, as the map shows it right now. */
  storm: 'calm' | 'storm';
  /** When the storm now showing stops being shown, in ms; null when calm. */
  stormUntil: number | null;
  /** Development-only previews. 'auto' means the real schedule decides. */
  phaseOverride: DayPhase | 'auto';
  oceanStormOverride: WeatherOverride;
  shoreStormOverride: WeatherOverride;
  setPhaseOverride: (v: DayPhase | 'auto') => void;
  setOceanStormOverride: (v: WeatherOverride) => void;
  setShoreStormOverride: (v: WeatherOverride) => void;
  /** Re-read the server's clock and weather now (after a DEV clock change on this device). */
  resync: () => Promise<void>;
}

const WeatherContext = createContext<WeatherState | null>(null);

// Re-evaluated on this cadence; a boundary is never more than this late. Cheap: two integer
// comparisons and a formatter.
const TICK_MS = 30_000;
// The account's weather is re-read on this cadence (and at once on resume and after this device
// reports a zone), so a change made on another device reaches this one within a poll.
const WEATHER_POLL_MS = 20_000;
// How often a foreground tab looks for a device time-zone change it has not been told about.
const ZONE_CHECK_MS = 60_000;

// The device's IANA zone (product decision 9), or null when the runtime gives nothing usable.
function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isIanaTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

// The last authoritative zone this browser saw for the account, so an offline start draws
// yesterday's clock rather than guessing. A convenience, never an authority.
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
  // Development clock offset, learned once and refreshed with the dev panel's own polling.
  const [offsetMs, setOffsetMs] = useState(0);
  // Monotonic time, re-read on every tick; with the latest server sample it gives the instant.
  const [monoNow, setMonoNow] = useState(() => monotonicNow());
  // The device clock, used only until the server's first answer arrives.
  const [wallNow, setWallNow] = useState(() => Date.now());
  const [sample, setSample] = useState<ClockSample | null>(null);
  const [phaseOverride, setPhaseOverride] = useState<DayPhase | 'auto'>('auto');
  const [oceanStormOverride, setOceanStormOverride] = useState<WeatherOverride>('auto');
  const [shoreStormOverride, setShoreStormOverride] = useState<WeatherOverride>('auto');
  const [account, setAccount] = useState<AccountWeatherDto | null>(null);

  const { user, setUser } = useSession();
  const userId = user?.id ?? null;
  const isDeveloper = user?.role === 'developer';
  const reportedZone = user?.timeZone ?? null;

  // The server's answer for this account: its zone, and its storm.
  const refresh = useCallback(() => {
    if (!userId) return Promise.resolve();
    return api
      .accountWeather()
      .then((w) => {
        const fresh = sampleOf(w.serverTime);
        if (fresh) {
          setSample(fresh);
          setMonoNow(fresh.monoMs);
        }
        setAccount(w);
        storeZone(w.timeZone);
      })
      .catch(() => {});
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void refresh();
    const id = setInterval(() => void refresh(), WEATHER_POLL_MS);
    return () => clearInterval(id);
  }, [userId, refresh]);

  // Report the device's zone after sign-in, on start, on returning to the foreground and when
  // a periodic look finds it changed. Unchanged zones are not sent (the server would ignore
  // them anyway); the server validates and decides, and the map is redrawn from its answer.
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    const sync = () => {
      if (document.hidden) return;
      const device = browserTimeZone();
      if (!device || device === reportedZone) {
        void refresh();
        return;
      }
      void api
        .syncTimeZone(device)
        .then((me) => {
          if (!alive) return;
          setUser(me);
          return refresh();
        })
        .catch(() => void refresh());
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    const id = setInterval(sync, ZONE_CHECK_MS);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      clearInterval(id);
    };
  }, [userId, reportedZone, setUser, refresh]);

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
    const tick = () => {
      setMonoNow(monotonicNow());
      setWallNow(Date.now());
    };
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

  // A signed-out view keeps nothing of the last account's weather.
  const current = userId ? account : null;
  const clock = userId ? sample : null;
  // Before the server has answered: the zone last seen for the account, else the device's own.
  const timeZone = current?.timeZone ?? readStoredZone() ?? browserTimeZone() ?? 'UTC';
  const instant = clock ? serverNow(clock, monoNow) : wallNow + offsetMs;
  const value = useMemo<WeatherState>(() => {
    const natural = phaseAt(instant, timeZone, DAYLIGHT_DEFAULTS);
    const span = current?.storm
      ? { from: Date.parse(current.storm.startsAt), until: Date.parse(current.storm.endsAt) }
      : null;
    // A storm is drawn only while it lasts and only on a night map.
    const active =
      natural === 'night' && span !== null && span.from <= instant && instant < span.until;
    return {
      phase: phaseOverride === 'auto' ? natural : phaseOverride,
      nowMs: instant,
      timeZone,
      storm: active ? 'storm' : 'calm',
      stormUntil: active ? span.until : null,
      phaseOverride,
      oceanStormOverride,
      shoreStormOverride,
      setPhaseOverride,
      setOceanStormOverride,
      setShoreStormOverride,
      resync: refresh,
    };
  }, [instant, timeZone, current, phaseOverride, oceanStormOverride, shoreStormOverride, refresh]);

  return <WeatherContext.Provider value={value}>{children}</WeatherContext.Provider>;
}

export function useWeather(): WeatherState {
  const ctx = useContext(WeatherContext);
  if (!ctx) throw new Error('useWeather outside WeatherProvider');
  return ctx;
}
