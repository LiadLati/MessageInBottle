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

// ---------- invisible formatting controls (audit SEC-018) ----------

// Bidirectional overrides/isolates and zero-width characters. They are legitimate in real
// right-to-left writing, so letters keep them; but they can make what a moderator sees
// rendered differ from the logical order that was written, so review surfaces flag them.
// Whether letters should refuse or strip them is a product decision, not made here.
const HIDDEN_CONTROLS = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;

const CONTROL_NAMES: Record<string, string> = {
  '\u200B': 'ZWSP',
  '\u200C': 'ZWNJ',
  '\u200D': 'ZWJ',
  '\u200E': 'LRM',
  '\u200F': 'RLM',
  '\u202A': 'LRE',
  '\u202B': 'RLE',
  '\u202C': 'PDF',
  '\u202D': 'LRO',
  '\u202E': 'RLO',
  '\u2060': 'WJ',
  '\u2066': 'LRI',
  '\u2067': 'RLI',
  '\u2068': 'FSI',
  '\u2069': 'PDI',
  '\uFEFF': 'BOM',
};

/** How many invisible formatting controls the text contains. */
export function countHiddenControls(text: string): number {
  return text.match(HIDDEN_CONTROLS)?.length ?? 0;
}

/** The text with every invisible control replaced by a visible, named marker such as ⟦RLO⟧. */
export function revealHiddenControls(text: string): string {
  return text.replace(
    HIDDEN_CONTROLS,
    (c) => `⟦${CONTROL_NAMES[c] ?? 'U+' + c.codePointAt(0)!.toString(16).toUpperCase()}⟧`,
  );
}
