import { describe, expect, it } from 'vitest';
import type { ShoreBottleDto } from '@mib/shared';
import { featuredBottle, sealedOnly, waitingBottles } from './shoreQueue.js';

const bottle = (id: string, state: 'delivered' | 'opened'): ShoreBottleDto => ({
  id,
  state,
  sender: { id: `u_${id}`, displayName: id },
  originShore: { id: 'shore_x', name: 'X' },
  releasedAt: '2026-09-01T00:00:00.000Z',
  deliveredAt: '2026-09-02T00:00:00.000Z',
  openedAt: state === 'opened' ? '2026-09-03T00:00:00.000Z' : null,
  journeyDurationMs: 86_400_000,
});

describe('shore queue (feature / swap, never open)', () => {
  const list = [bottle('a', 'delivered'), bottle('b', 'delivered'), bottle('c', 'delivered')];

  it('features the newest sealed bottle by default and lists the rest', () => {
    const sealed = sealedOnly(list);
    const featured = featuredBottle(sealed, null);
    expect(featured?.id).toBe('a');
    expect(waitingBottles(sealed, featured).map((b) => b.id)).toEqual(['b', 'c']);
  });

  it('swaps a chosen waiting bottle into the featured slot and moves the old one back', () => {
    const sealed = sealedOnly(list);
    const featured = featuredBottle(sealed, 'c');
    expect(featured?.id).toBe('c');
    expect(waitingBottles(sealed, featured).map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('drops opened bottles from the shore and falls back to the next sealed one', () => {
    const after = [bottle('a', 'opened'), bottle('b', 'delivered'), bottle('c', 'delivered')];
    const sealed = sealedOnly(after);
    expect(sealed.map((b) => b.id)).toEqual(['b', 'c']);
    // The selection pointed at the bottle that was just opened: the next sealed one is featured.
    expect(featuredBottle(sealed, 'a')?.id).toBe('b');
    expect(featuredBottle(sealedOnly([bottle('a', 'opened')]), 'a')).toBeNull();
  });
});
