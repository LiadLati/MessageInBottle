import { describe, expect, it } from 'vitest';
import { displayTimeZone, harbourTimeZone, isIanaTimeZone } from './timezone.js';

describe('device time zone (product decision 9)', () => {
  it.each([
    'Europe/Berlin',
    'Asia/Jerusalem',
    'America/Argentina/Buenos_Aires',
    'UTC',
    'Etc/GMT-2',
  ])('accepts the IANA zone %s', (zone) => expect(isIanaTimeZone(zone)).toBe(true));
  it.each([
    '+05:00',
    'GMT+2',
    'EST',
    'Mars/Olympus_Mons',
    'Europe/Berlin; drop table',
    '',
    42,
    null,
  ])('refuses %s', (zone) => expect(isIanaTimeZone(zone)).toBe(false));
  it('falls back to the harbour zone, then UTC', () => {
    expect(displayTimeZone('Asia/Tokyo', 34)).toBe('Asia/Tokyo');
    expect(displayTimeZone(undefined, 34.8)).toBe('Etc/GMT-2');
    expect(displayTimeZone('nonsense', -74)).toBe('Etc/GMT+5');
    expect(displayTimeZone(null, 3)).toBe('UTC');
    expect(displayTimeZone(null, null)).toBe('UTC');
    expect(harbourTimeZone(179.9)).toBe('Etc/GMT-12');
    for (const lng of [-180, -90, 0, 90, 180])
      expect(isIanaTimeZone(harbourTimeZone(lng))).toBe(true);
  });
});
