// The server's clock, as this device can know it (audit FE-R-003).
//
// A device's wall clock can be wrong by hours, or be changed while the app is open. The API
// says what time it is (`serverTime`); that sample is the authority. Between samples it is
// advanced with the monotonic clock (`performance.now()`), which counts elapsed time and never
// jumps when someone sets the wall clock. Every fresh sample replaces the last one.
export interface ClockSample {
  /** The server's time when the sample was taken, in ms since the epoch. */
  serverMs: number;
  /** `performance.now()` when the sample arrived. */
  monoMs: number;
}

export const monotonicNow = (): number => performance.now();

export function sampleOf(serverTime: string, monoMs: number = monotonicNow()): ClockSample | null {
  const serverMs = Date.parse(serverTime);
  return Number.isFinite(serverMs) ? { serverMs, monoMs } : null;
}

/** The server's time now, from the latest sample and the elapsed monotonic time. */
export function serverNow(sample: ClockSample, monoMs: number = monotonicNow()): number {
  return sample.serverMs + Math.max(0, monoMs - sample.monoMs);
}
