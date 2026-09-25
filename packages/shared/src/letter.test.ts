import { describe, expect, it } from 'vitest';
import {
  LETTER_MAX_CHARACTERS,
  countHiddenControls,
  hasDirectionControls,
  normalizeLetterText,
  countLetterCharacters,
  revealHiddenControls,
  validateLetterText,
} from './letter.js';
import { canTransition, isTerminal } from './bottle-state.js';

describe('letter character counting', () => {
  it('counts user-perceived characters, not code units', () => {
    expect(countLetterCharacters('abc')).toBe(3);
    expect(countLetterCharacters('👩\u200D👩\u200D👧\u200D👦')).toBe(1);
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
    const family = '👩\u200D👩\u200D👧\u200D👦'.repeat(400); // 400 graphemes, ~10 KB
    const res = validateLetterText(family);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('too_many_bytes');
  });
});

describe('bottle state model', () => {
  it('allows only the transitions the server performs', () => {
    expect(canTransition('at_sea', 'delivered')).toBe(true);
    expect(canTransition('at_sea', 'lost')).toBe(true);
    expect(canTransition('at_sea', 'cancelled')).toBe(true);
    expect(canTransition('delivered', 'opened')).toBe(true);
    expect(canTransition('opened', 'at_sea')).toBe(false);
    expect(canTransition('lost', 'at_sea')).toBe(false);
  });

  it('marks terminal states', () => {
    for (const s of ['opened', 'lost', 'cancelled'] as const) expect(isTerminal(s)).toBe(true);
    expect(isTerminal('delivered')).toBe(false);
  });
});

describe('invisible formatting controls (SEC-018)', () => {
  it('counts and reveals bidi overrides and zero-width characters', () => {
    const text = 'pay \u202Eyrrac\u202C now\u200B';
    expect(countHiddenControls(text)).toBe(3);
    expect(revealHiddenControls(text)).toBe('pay ⟦RLO⟧yrrac⟦PDF⟧ now⟦ZWSP⟧');
  });
  it('leaves ordinary text, including real right-to-left text, alone', () => {
    expect(countHiddenControls('שלום, dear friend')).toBe(0);
    expect(revealHiddenControls('שלום')).toBe('שלום');
  });
});

describe('invisible direction controls (product decision 11)', () => {
  const controls = ['202A', '202B', '202C', '202D', '202E', '2066', '2067', '2068', '2069'];

  it.each(controls)('refuses U+%s instead of stripping it', (hex) => {
    const text = `Dear friend, ${String.fromCodePoint(parseInt(hex, 16))}see you soon`;
    const v = validateLetterText(text);
    expect(v).toMatchObject({ ok: false, reason: 'direction_controls' });
  });

  it('catches known spoofing samples', () => {
    // A right-to-left override that makes "exe.pdf" display as "fdp.exe"-style text.
    expect(hasDirectionControls('invoice_\u202Efdp.exe')).toBe(true);
    // An isolate pair hiding reordered words.
    expect(hasDirectionControls('pay \u206710\u2069 euros')).toBe(true);
    // Trojan-source style: a comment-like span closed by a pop.
    expect(hasDirectionControls('ok \u202E } \u202Aif (admin)\u202C')).toBe(true);
  });

  it.each([
    ['Hebrew', 'שלום, מה שלומך? נתראה בקרוב.'],
    ['Arabic', 'مرحبا يا صديقي، أراك قريبا.'],
    ['mixed Hebrew, English and Arabic', 'Hello שלום مرحبا — see you at 10:30 (עם קפה).'],
    [
      'emoji with joiners and a flag',
      'Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} and \u{1F1EE}\u{1F1F1} with ❤️ and 👍🏽',
    ],
    ['directional marks writers use', 'עברית\u200F 123 and English\u200E text, عربي\u061C'],
    ['Persian with a zero-width non-joiner', 'می\u200Cخواهم'],
    ['punctuation and quotes', '«Bonjour» — “quoted” ‘text’ … ¿qué? ¡sí!'],
  ])('accepts ordinary %s text unchanged', (_label, text) => {
    expect(validateLetterText(text)).toMatchObject({ ok: true });
    expect(normalizeLetterText(text)).toBe(text);
  });
});
