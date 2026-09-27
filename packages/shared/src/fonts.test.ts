import { describe, expect, it } from 'vitest';
import { LetterFontSchema } from './api.js';
import { FONT_DEFINITIONS, LETTER_FONTS } from './fonts.js';

// Manual review round 2, item 3: four more letter faces. Stored identifiers are forever, so the
// original four keep their ids, positions and families, and letters written in them render as
// before.

describe('the letter font catalogue', () => {
  it('keeps the original four exactly as they were', () => {
    expect(LETTER_FONTS.slice(0, 4)).toEqual(['handwriting', 'calligraphy', 'typewriter', 'print']);
    expect(FONT_DEFINITIONS.handwriting.cssFamily).toMatch(/^'Caveat'/);
    expect(FONT_DEFINITIONS.calligraphy.cssFamily).toMatch(/^'Italianno'/);
    expect(FONT_DEFINITIONS.typewriter.cssFamily).toMatch(/^'Special Elite'/);
    expect(FONT_DEFINITIONS.print.cssFamily).toMatch(/^'Lora'/);
  });

  it('adds four distinct faces, each with its own family, label and metrics', () => {
    expect(LETTER_FONTS).toHaveLength(8);
    const added = LETTER_FONTS.slice(4);
    expect(added.map((f) => FONT_DEFINITIONS[f].cssFamily.split(',')[0])).toEqual([
      "'Dancing Script'",
      "'Patrick Hand'",
      "'Libre Baskerville'",
      "'Nunito'",
    ]);
    const labels = LETTER_FONTS.map((f) => FONT_DEFINITIONS[f].label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const f of added) {
      expect(FONT_DEFINITIONS[f].id).toBe(f);
      expect(FONT_DEFINITIONS[f].sizePx).toBeGreaterThan(12);
    }
  });

  it('accepts every catalogue id, and only those, as a stored letter font', () => {
    for (const f of LETTER_FONTS) expect(LetterFontSchema.parse(f)).toBe(f);
    expect(LetterFontSchema.safeParse('comic').success).toBe(false);
  });
});
