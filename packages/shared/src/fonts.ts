// Visual fonts affect presentation only (spec §10.1). Families follow the design handoff
// (FONTS.md): four OFL letter faces chosen for shape as placeholders for licensed faces, with
// script fallbacks so unsupported scripts render in a serif rather than tofu. The identifiers
// below are what is stored with a letter; changing a family never changes stored text.
export const LETTER_FONTS = ['handwriting', 'calligraphy', 'typewriter', 'print'] as const;
export type LetterFont = (typeof LETTER_FONTS)[number];

export const READABLE_PRINT_FONT = 'readable_print' as const;

export interface FontDefinition {
  id: LetterFont | typeof READABLE_PRINT_FONT;
  label: string;
  cssFamily: string;
  cssStyle?: string;
  // Metrics from DESIGN_TOKENS.json typography.letterFaceMetrics (px / unitless line-height).
  sizePx: number;
  lineHeight: number;
}

const SCRIPT_FALLBACK =
  "'Noto Serif Hebrew', 'Noto Naskh Arabic', 'Noto Serif CJK SC', 'Lora', Georgia, serif";

export const FONT_DEFINITIONS: Record<LetterFont | typeof READABLE_PRINT_FONT, FontDefinition> = {
  handwriting: {
    id: 'handwriting',
    label: 'Handwriting',
    cssFamily: `'Caveat', 'Segoe Script', ${SCRIPT_FALLBACK}, cursive`,
    sizePx: 25,
    lineHeight: 1.45,
  },
  calligraphy: {
    id: 'calligraphy',
    label: 'Calligraphy',
    cssFamily: `'Italianno', 'Apple Chancery', ${SCRIPT_FALLBACK}, cursive`,
    sizePx: 31,
    lineHeight: 1.2,
  },
  typewriter: {
    id: 'typewriter',
    label: 'Typewriter',
    cssFamily: `'Special Elite', 'Courier New', ${SCRIPT_FALLBACK}, ui-monospace, monospace`,
    sizePx: 15,
    lineHeight: 1.75,
  },
  print: {
    id: 'print',
    label: 'Printed',
    cssFamily: `'Lora', ${SCRIPT_FALLBACK}`,
    sizePx: 16.5,
    lineHeight: 1.7,
  },
  readable_print: {
    id: 'readable_print',
    label: 'Readable Print',
    cssFamily: "'Instrument Sans', -apple-system, 'Segoe UI', Roboto, sans-serif",
    sizePx: 17,
    lineHeight: 1.6,
  },
};

export const DEFAULT_LETTER_FONT: LetterFont = 'handwriting';
