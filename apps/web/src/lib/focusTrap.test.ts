import { describe, expect, it } from 'vitest';
import { nextTabTarget } from './focusTrap.js';

// Minimal stand-ins: the trap only compares identities.
const el = (name: string) => ({ name }) as unknown as HTMLElement;

describe('modal focus trap', () => {
  const [a, b, c] = [el('a'), el('b'), el('c')];
  const list = [a, b, c];

  it('wraps Tab from the last control to the first and Shift+Tab from the first to the last', () => {
    expect(nextTabTarget(list, c, false)).toBe(a);
    expect(nextTabTarget(list, a, true)).toBe(c);
  });

  it('lets the browser move between inner controls', () => {
    expect(nextTabTarget(list, a, false)).toBeNull();
    expect(nextTabTarget(list, b, true)).toBeNull();
  });

  it('pulls focus back inside when it escaped the dialog', () => {
    expect(nextTabTarget(list, el('outside'), false)).toBe(a);
    expect(nextTabTarget(list, null, true)).toBe(c);
    expect(nextTabTarget([], a, false)).toBeNull();
  });
});
