// Product decision 9: the device reports its IANA time zone
// (Intl.DateTimeFormat().resolvedOptions().timeZone); no location permission is involved. Once
// the server accepts it, it is the account's authoritative map clock: the map's day and night
// and future storm eligibility (risk policy v4, weather.ts). Journey duration, arrival,
// deadlines, suspensions, appeals, retention and rate limits run on server time and never read
// it, and a change never rerolls weather or touches a decision already made.

// An IANA zone name of the forms the tz database uses ("Europe/Berlin", "America/Argentina/
// Buenos_Aires", "Etc/GMT-2", "UTC") that the runtime also knows. Offsets such as "+05:00",
// abbreviations and arbitrary text are refused.
const IANA_NAME =
  /^(?:UTC|Etc\/(?:UTC|GMT(?:[+-](?:[0-9]|1[0-4]))?)|[A-Z][A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;

export function isIanaTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length > 64 || !IANA_NAME.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// The fallback when a device gives no usable zone: the nautical zone of the chosen harbour,
// from its longitude (15° per hour), as an IANA "Etc/GMT" zone. Note the tz database's
// inverted sign: Etc/GMT-2 is UTC+2.
export function harbourTimeZone(lng: number | null | undefined): string | null {
  if (lng === null || lng === undefined || !Number.isFinite(lng)) return null;
  const hours = Math.max(-12, Math.min(14, Math.round(lng / 15)));
  if (hours === 0) return 'UTC';
  return `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
}

// What the display follows: the device's zone when it is valid, else the harbour's, else UTC.
export function displayTimeZone(
  deviceZone: unknown,
  harbourLng: number | null | undefined,
): string {
  if (isIanaTimeZone(deviceZone)) return deviceZone;
  return harbourTimeZone(harbourLng) ?? 'UTC';
}
