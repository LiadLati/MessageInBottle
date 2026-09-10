import { describe, expect, it } from 'vitest';
import { LETTER_MAX_CHARACTERS, countLetterCharacters, validateLetterText } from './letter.js';
import { canTransition, isTerminal } from './bottle-state.js';

describe('letter character counting', () => {
  it('counts user-perceived characters, not code units', () => {
    expect(countLetterCharacters('abc')).toBe(3);
    expect(countLetterCharacters('👩‍👩‍👧‍👦')).toBe(1);
    expect(countLetterCharacters('é')).toBe(1);
    expect(countLetterCharacters('שלום')).toBe(4);
  });

  it('accepts exactly the maximum and rejects one more', () => {
    expect(validateLetterText('a'.repeat(LETTER_MAX_CHARACTERS)).ok).toBe(true);
    const over = validateLetterText('a'.repeat(LETTER_MAX_CHARACTERS + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe('too_long');
  });

  it('rejects empty or whitespace-only text', () => {
    expect(validateLetterText('   \n').ok).toBe(false);
  });

  it('enforces the byte safety limit independently of grapheme count', () => {
    const family = '👩‍👩‍👧‍👦'.repeat(400); // 400 graphemes, ~10 KB
    const res = validateLetterText(family);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('too_many_bytes');
  });
});

describe('bottle state model', () => {
  it('follows the v0.2 transitions', () => {
    expect(canTransition('at_sea', 'delivered')).toBe(true);
    expect(canTransition('delivered', 'opened')).toBe(true);
    expect(canTransition('opened', 'at_sea')).toBe(false);
    expect(canTransition('public_expired', 'at_sea')).toBe(false);
    expect(canTransition('stranded_public', 'at_sea')).toBe(true);
  });

  it('marks terminal states', () => {
    for (const s of ['opened', 'discarded', 'lost', 'cancelled'] as const)
      expect(isTerminal(s)).toBe(true);
    expect(isTerminal('delivered')).toBe(false);
  });
});
