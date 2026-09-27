// Visual fonts affect presentation only (spec §10.1). Families follow the design handoff
// (docs/FONTS.md): eight open-licence, self-hosted letter faces (seven OFL-1.1, Special Elite
// Apache-2.0), with script fallbacks so unsupported scripts render in a serif rather than tofu.
// The identifiers below are what is stored with a letter: the first four are the original set
// and never change; later faces are only ever appended (manual review round 2 added four).
// Changing a family never changes stored text.
export const LETTER_FONTS = [
  'handwriting',
  'calligraphy',
  'typewriter',
  'print',
  'script',
  'neat_hand',
  'classic',
  'rounded',
] as const;
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
  script: {
    id: 'script',
    label: 'Flowing script',
    cssFamily: `'Dancing Script', 'Segoe Script', ${SCRIPT_FALLBACK}, cursive`,
    sizePx: 23,
    lineHeight: 1.45,
  },
  neat_hand: {
    id: 'neat_hand',
    label: 'Neat hand',
    cssFamily: `'Patrick Hand', 'Segoe Print', ${SCRIPT_FALLBACK}, cursive`,
    sizePx: 20,
    lineHeight: 1.55,
  },
  classic: {
    id: 'classic',
    label: 'Classic',
    cssFamily: `'Libre Baskerville', Baskerville, ${SCRIPT_FALLBACK}`,
    sizePx: 15.5,
    lineHeight: 1.8,
  },
  rounded: {
    id: 'rounded',
    label: 'Rounded',
    cssFamily: `'Nunito', ${SCRIPT_FALLBACK}`,
    sizePx: 17,
    lineHeight: 1.65,
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
