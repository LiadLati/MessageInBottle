import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { FONT_DEFINITIONS, type AgingProfile, type LetterFont } from '@mib/shared';
import { Icon } from '../design/Icon.js';

interface Props {
  text: string;
  font: LetterFont;
  aging?: AgingProfile | undefined;
  full?: boolean;
  readable?: boolean;
  onReadableChange?: (readable: boolean) => void;
  toolbar?: 'inline' | 'none';
  children?: ReactNode;
}

// The four letter faces load lazily the first time a letter surface is shown (FONTS.md).
let letterFacesRequested = false;
export function ensureLetterFaces() {
  if (letterFacesRequested) return;
  letterFacesRequested = true;
  void Promise.all([
    import('@fontsource/caveat/400.css'),
    import('@fontsource/italianno/400.css'),
    import('@fontsource/special-elite/400.css'),
    import('@fontsource/lora/400.css'),
  ]);
}

export function letterTextStyle(font: LetterFont, readable: boolean): CSSProperties {
  const def = readable ? FONT_DEFINITIONS.readable_print : FONT_DEFINITIONS[font];
  return {
    fontFamily: def.cssFamily,
    fontStyle: def.cssStyle ?? 'normal',
    fontSize: def.sizePx,
    lineHeight: def.lineHeight,
  };
}

// Renders exactly the stored text on the one parchment surface the design allows. Font and
// aging are presentation layers only (spec §10): Readable Print swaps the typeface and hides
// decoration without touching a single character; aging layers sit under the text.
export function LetterPaper({
  text,
  font,
  aging,
  full = false,
  readable: readableProp,
  onReadableChange,
  toolbar = 'inline',
  children,
}: Props) {
  const [readableState, setReadableState] = useState(false);
  const readable = readableProp ?? readableState;
  const setReadable = (v: boolean) => {
    setReadableState(v);
    onReadableChange?.(v);
  };
  useEffect(ensureLetterFaces, []);

  const decorated = Boolean(aging) && !readable;
  const paperStyle: CSSProperties = decorated
    ? {
        background: `radial-gradient(120% 70% at 30% 0%, rgba(255,255,255,${0.35 - aging!.yellowing * 0.2}), transparent 60%), hsl(40 ${52 + aging!.yellowing * 18}% ${89 - aging!.yellowing * 14}%)`,
      }
    : {};

  return (
    <div className={`parchment${full ? ' full' : ''}`} style={paperStyle}>
      <span
        className="grain"
        aria-hidden
        style={decorated ? { opacity: 0.05 + aging!.wear * 0.08 } : undefined}
      />
      {decorated
        ? aging!.stains.map((s, i) => (
            <span
              key={`s${i}`}
              aria-hidden
              className="stain"
              style={{
                left: `${s.x * 100}%`,
                top: `${s.y * 100}%`,
                width: `${s.size * 160}%`,
                paddingTop: `${s.size * 160}%`,
                transform: 'translate(-50%, -50%)',
              }}
            />
          ))
        : null}
      {decorated
        ? aging!.tears.map((tear, i) => (
            <span
              key={`t${i}`}
              aria-hidden
              className={`tear ${tear.edge}`}
              style={tearStyle(tear)}
            />
          ))
        : null}
      {toolbar === 'inline' ? (
        <div className="letter-toolbar">
          <span>
            {readable
              ? 'Readable Print · same words'
              : `${FONT_DEFINITIONS[font].label} · original`}
          </span>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setReadable(!readable)}
            aria-pressed={readable}
          >
            <Icon name="readable-print" size={14} />
            Readable Print
          </button>
        </div>
      ) : null}
      {children}
      <p className="letter-body" dir="auto" style={letterTextStyle(font, readable)}>
        {text}
      </p>
    </div>
  );
}

function tearStyle(tear: AgingProfile['tears'][number]): CSSProperties {
  const pct = `${tear.at * 100}%`;
  return tear.edge === 'top' || tear.edge === 'bottom' ? { left: pct } : { top: pct };
}
