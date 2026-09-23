# Bundled fonts and licences

The web app bundles its fonts from [Fontsource](https://fontsource.org) npm packages
(`apps/web/package.json`); the font files are emitted into `apps/web/dist/assets/` at build time.
No font file is committed to the repository. Each licence below was read from the `LICENSE`
file shipped inside the installed package (`apps/web/node_modules/@fontsource/<name>/LICENSE`,
version 5.3.0), which is also what the package's `license` field declares.

| Family | Package | Used for | Where it is loaded | Licence | Copyright (from the package's `LICENSE`) |
| --- | --- | --- | --- | --- | --- |
| Caveat | `@fontsource/caveat` | Letter face: Handwriting | `apps/web/src/components/LetterPaper.tsx` | SIL Open Font License 1.1 | 2014 The Caveat Project Authors |
| Italianno | `@fontsource/italianno` | Letter face: Calligraphy | `apps/web/src/components/LetterPaper.tsx` | SIL Open Font License 1.1 | 2009 The Italianno Project Authors |
| Special Elite | `@fontsource/special-elite` | Letter face: Typewriter | `apps/web/src/components/LetterPaper.tsx` | Apache License 2.0 | 2010 Brian J. Bonislawsky DBA Astigmatic (AOETI) (stated in the package README) |
| Lora | `@fontsource/lora` | Letter face: Printed; script fallback | `apps/web/src/components/LetterPaper.tsx` | SIL Open Font License 1.1, Reserved Font Name "Lora" | 2011 The Lora Project Authors |
| Instrument Sans | `@fontsource/instrument-sans` (400, 500, 600) | Interface text and Readable Print | `apps/web/src/main.tsx` | SIL Open Font License 1.1 | 2022 The Instrument Sans Project Authors |
| EB Garamond | `@fontsource/eb-garamond` (400, 400 italic, 500) | Interface display text | `apps/web/src/main.tsx` | SIL Open Font License 1.1 | 2017 The EB Garamond Project Authors |

Letter faces are mapped to these families in `packages/shared/src/fonts.ts`.

## Not bundled

The script fallbacks named in `packages/shared/src/fonts.ts` (Noto Serif Hebrew, Noto Naskh
Arabic, Noto Serif CJK SC) and the system names in each stack (Segoe Script, Apple Chancery,
Courier New, Georgia, -apple-system, Segoe UI, Roboto) are **not** shipped by the app; they are
used only if the reader's device already has them. No licence obligation arises from the app for
these, and none is recorded here.

## Obligations when distributing

- **OFL 1.1** (Caveat, Italianno, Lora, Instrument Sans, EB Garamond): the fonts may be bundled
  and redistributed with the app; the copyright notice and licence must accompany the font
  software when it is redistributed on its own, the fonts may not be sold by themselves, and a
  modified version may not use a Reserved Font Name (here, "Lora").
- **Apache 2.0** (Special Elite): redistribution must include a copy of the licence and keep the
  copyright notice.

Before a public release, confirm that the built artefact or its notices page carries these
licence texts; this document records what is used and under which licence, not that the notices
are shipped.
