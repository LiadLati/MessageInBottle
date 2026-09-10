export const LETTER_MAX_CHARACTERS = 1000;
// Separate safe byte limit (spec §10.1) so pathological grapheme clusters cannot bloat storage.
export const LETTER_MAX_BYTES = 8000;

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

// User-perceived characters: identical counting on client and server.
export function countLetterCharacters(text: string): number {
  if (segmenter) return [...segmenter.segment(text)].length;
  return Array.from(text).length;
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export type LetterValidation =
  | { ok: true; characters: number }
  | { ok: false; reason: 'empty' | 'too_long' | 'too_many_bytes'; characters: number };

export function normalizeLetterText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function validateLetterText(raw: string): LetterValidation {
  const text = normalizeLetterText(raw);
  const characters = countLetterCharacters(text);
  if (text.trim().length === 0) return { ok: false, reason: 'empty', characters };
  if (characters > LETTER_MAX_CHARACTERS) return { ok: false, reason: 'too_long', characters };
  if (utf8ByteLength(text) > LETTER_MAX_BYTES)
    return { ok: false, reason: 'too_many_bytes', characters };
  return { ok: true, characters };
}
