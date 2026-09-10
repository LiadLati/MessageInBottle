// Visual fonts affect presentation only (spec §10.1). Final typefaces and licenses
// are chosen in the design phase; these are placeholder identifiers + system stacks.
export const LETTER_FONTS = ['handwriting', 'calligraphy', 'typewriter', 'print'] as const;
export type LetterFont = (typeof LETTER_FONTS)[number];

export const READABLE_PRINT_FONT = 'readable_print' as const;

export interface FontDefinition {
  id: LetterFont | typeof READABLE_PRINT_FONT;
  label: string;
  cssFamily: string;
  cssStyle?: string;
}

export const FONT_DEFINITIONS: Record<LetterFont | typeof READABLE_PRINT_FONT, FontDefinition> = {
  handwriting: {
    id: 'handwriting',
    label: 'Handwriting',
    cssFamily: '"Bradley Hand", "Segoe Script", "Comic Sans MS", cursive',
  },
  calligraphy: {
    id: 'calligraphy',
    label: 'Calligraphy',
    cssFamily: '"Snell Roundhand", "Brush Script MT", "Apple Chancery", cursive',
    cssStyle: 'italic',
  },
  typewriter: {
    id: 'typewriter',
    label: 'Typewriter',
    cssFamily: '"Courier New", Courier, "Liberation Mono", monospace',
  },
  print: {
    id: 'print',
    label: 'Printed',
    cssFamily: 'Georgia, "Times New Roman", serif',
  },
  readable_print: {
    id: 'readable_print',
    label: 'Readable Print',
    cssFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
};

export const DEFAULT_LETTER_FONT: LetterFont = 'handwriting';
