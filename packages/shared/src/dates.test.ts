import { describe, expect, it } from 'vitest';
import { formatClock, formatDateOnly, formatDateTime, sameDay } from './dates.js';

// One English style for every date a person reads, independent of the runtime's language.

const AT = '2026-10-26T17:35:00.000Z';

describe('the shared English date formatter', () => {
  it('writes day, short month, year and a 24-hour time', () => {
    expect(formatDateTime(AT, 'UTC')).toBe('26 Oct 2026, 17:35');
    expect(formatDateOnly(AT, 'UTC')).toBe('26 Oct 2026');
    expect(formatClock(AT, 'UTC')).toBe('17:35');
  });

  it('shows the wall clock of the zone it is given', () => {
    expect(formatDateTime(AT, 'Asia/Jerusalem')).toBe('26 Oct 2026, 19:35');
    expect(formatDateTime('2026-09-29T23:15:00.000Z', 'Europe/Berlin')).toBe('30 Sep 2026, 01:15');
  });

  it('uses the same month names whatever the ICU build calls them', () => {
    const months = Array.from({ length: 12 }, (_, m) =>
      formatDateOnly(Date.UTC(2026, m, 5, 12), 'UTC'),
    );
    expect(months).toEqual([
      '5 Jan 2026',
      '5 Feb 2026',
      '5 Mar 2026',
      '5 Apr 2026',
      '5 May 2026',
      '5 Jun 2026',
      '5 Jul 2026',
      '5 Aug 2026',
      '5 Sep 2026',
      '5 Oct 2026',
      '5 Nov 2026',
      '5 Dec 2026',
    ]);
  });

  it('writes midnight as 00:00, never 24:00', () => {
    expect(formatClock('2026-10-26T00:05:00.000Z', 'UTC')).toBe('00:05');
  });

  it('tells whether two instants share a calendar day in a zone', () => {
    expect(sameDay('2026-10-26T01:00:00Z', '2026-10-26T22:00:00Z', 'UTC')).toBe(true);
    expect(sameDay('2026-10-26T01:00:00Z', '2026-10-26T22:00:00Z', 'Asia/Jerusalem')).toBe(false);
  });
});
