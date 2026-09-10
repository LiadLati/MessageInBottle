import { useState } from 'react';
import { FONT_DEFINITIONS, type AgingProfile, type LetterFont } from '@mib/shared';

interface Props {
  text: string;
  font: LetterFont;
  aging?: AgingProfile | undefined;
  readableDefault?: boolean;
}

// Renders exactly the stored text. Font and aging are presentation layers only (spec §10):
// Readable Print swaps the typeface and removes decoration without touching a single character.
export function LetterPaper({ text, font, aging, readableDefault = false }: Props) {
  const [readable, setReadable] = useState(readableDefault);
  const def = readable ? FONT_DEFINITIONS.readable_print : FONT_DEFINITIONS[font];
  const paperStyle: React.CSSProperties =
    aging && !readable
      ? {
          background: `linear-gradient(180deg, hsl(45 60% ${94 - aging.yellowing * 20}%), hsl(40 55% ${90 - aging.yellowing * 25}%))`,
          filter: `saturate(${1 + aging.wear * 0.3})`,
        }
      : {};
  return (
    <div className="letter-wrap">
      <div className="letter-toolbar">
        <span className="muted small">
          {readable ? 'Readable Print' : `${FONT_DEFINITIONS[font].label} (original)`}
        </span>
        <button
          type="button"
          className="btn small"
          onClick={() => setReadable((r) => !r)}
          aria-pressed={readable}
        >
          {readable ? 'Show original look' : 'Readable Print'}
        </button>
      </div>
      <div className={`paper${aging && !readable ? ' paper-aged' : ''}`} style={paperStyle}>
        {aging && !readable
          ? aging.stains.map((s, i) => (
              <span
                key={i}
                aria-hidden
                className="paper-stain"
                style={{
                  left: `${s.x * 100}%`,
                  top: `${s.y * 100}%`,
                  width: `${s.size * 100}%`,
                  paddingTop: `${s.size * 100}%`,
                }}
              />
            ))
          : null}
        {aging && !readable
          ? aging.tears.map((tear, i) => (
              <span
                key={i}
                aria-hidden
                className={`paper-tear paper-tear-${tear.edge}`}
                style={tearStyle(tear)}
              />
            ))
          : null}
        <p
          className="letter-text"
          dir="auto"
          style={{ fontFamily: def.cssFamily, fontStyle: def.cssStyle ?? 'normal' }}
        >
          {text}
        </p>
      </div>
    </div>
  );
}

function tearStyle(tear: AgingProfile['tears'][number]): React.CSSProperties {
  const pct = `${tear.at * 100}%`;
  switch (tear.edge) {
    case 'top':
      return { left: pct, top: 0 };
    case 'bottom':
      return { left: pct, bottom: 0 };
    case 'left':
      return { top: pct, left: 0 };
    case 'right':
      return { top: pct, right: 0 };
  }
}
