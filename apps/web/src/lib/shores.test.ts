import { describe, expect, it } from 'vitest';
import { describeShore, matchesShore } from './shores.js';

describe('shore presentation (no country names, spec §6.2)', () => {
  const lisbon = { name: 'Lisbon', sea: 'North Atlantic', capacity: 5 };

  it('describes a shore by its sea and places only', () => {
    expect(describeShore(lisbon)).toBe('North Atlantic · 5 places');
    expect(describeShore({ sea: null, capacity: 3 })).toBe('App anchor · 3 places');
    expect(describeShore(lisbon)).not.toMatch(/Portugal/);
  });

  it('searches by harbour name or sea, accent-insensitively, never by country', () => {
    expect(matchesShore(lisbon, 'lisb')).toBe(true);
    expect(matchesShore(lisbon, 'atlantic')).toBe(true);
    expect(matchesShore({ name: 'Málaga', sea: 'Mediterranean Sea' }, 'malaga')).toBe(true);
    expect(matchesShore(lisbon, 'Portugal')).toBe(false);
    expect(matchesShore(lisbon, '')).toBe(true);
  });
});
