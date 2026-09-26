import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDate, formatDay, formatDayTime, formatTime } from './format.js';

// Manual review round 1: every date a person reads is English — "26 Oct 2026, 17:35" — even in a
// browser set to Hebrew. The screenshot that prompted this read "26 בספט׳ 2026, 17:37".

const STYLE = /^\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}, \d{2}:\d{2}$/;

afterEach(() => vi.restoreAllMocks());

describe('user-facing dates are English whatever the browser language', () => {
  it('formats a date and time in the one shared style', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('he-IL');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['he-IL']);
    expect(formatDate('2026-09-26T14:37:00.000Z')).toMatch(STYLE);
    expect(formatDay('2026-09-26T14:37:00.000Z')).toMatch(/^\d{1,2} Sep 2026$/);
    expect(formatTime('2026-09-26T14:37:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
    expect(formatDayTime('2020-01-02T10:00:00.000Z')).toMatch(STYLE);
    expect(formatDayTime(new Date().toISOString())).toMatch(/^today, \d{2}:\d{2}$/);
  });

  it('leaves no screen formatting dates with the browser’s own locale', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const src = readFileSync(path, 'utf8');
          if (/toLocale(Date|Time)?String\(|DateTimeFormat\(undefined/.test(src)) {
            offenders.push(path);
          }
        }
      }
    };
    walk(join(__dirname, '..'));
    expect(offenders).toEqual([]);
  });
});
