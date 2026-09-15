import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OpenedLetterDto } from '@mib/shared';
import { Icon } from '../design/Icon.js';
import { focusableIn, nextTabTarget } from '../lib/focusTrap.js';
import { formatDuration, prefersReducedMotion } from '../lib/format.js';
import { LetterPaper } from './LetterPaper.js';

interface Props {
  letter: OpenedLetterDto;
  justOpened: boolean;
  onClose: () => void;
}

const CLOSE_MS = 260;
const CLOSE_MS_REDUCED = 120;

// S8 · Opened letter as a modal over the shore: the parchment floats with the shore visible
// around it and the navigation still drawn but inert. Proper dialog semantics: the rest of the
// app is `inert`, focus is trapped and restored, Escape closes, the page behind cannot scroll.
// Exactly two controls (Back to shore, Readable Print); text is selectable, dir="auto", and the
// stored words are rendered verbatim (storyboard §D).
export function LetterModal({ letter, justOpened, onClose }: Props) {
  const [readable, setReadable] = useState(false);
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const b = letter.bottle;

  // Inert background + focus restore. `inert` is applied to every top-level sibling of the
  // portal (the app shell, including the bottom navigation), never to the dialog itself.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = [...document.body.children].filter(
      (el) => el !== dialogRef.current?.parentElement,
    );
    for (const el of siblings) el.setAttribute('inert', '');
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusables = focusableIn(dialogRef.current!);
    (focusables[0] ?? dialogRef.current)?.focus();
    return () => {
      for (const el of siblings) el.removeAttribute('inert');
      document.body.style.overflow = bodyOverflow;
      previous?.focus();
    };
  }, []);

  const close = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, prefersReducedMotion() ? CLOSE_MS_REDUCED : CLOSE_MS);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const target = nextTabTarget(
      focusableIn(dialogRef.current),
      document.activeElement,
      e.shiftKey,
    );
    if (target) {
      e.preventDefault();
      target.focus();
    }
  };

  return createPortal(
    <div className={`letter-modal${closing ? ' closing' : ''}`} onKeyDown={onKeyDown}>
      <div className="letter-modal-backdrop" onClick={close} aria-hidden />
      {justOpened && !closing ? <div className="veil" aria-hidden /> : null}
      <div
        ref={dialogRef}
        className="letter-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="letter-modal-top letter-chrome">
          <button type="button" className="btn-ghost" onClick={close}>
            <Icon name="back" size={14} />
            Back to shore
          </button>
          <span id={titleId} className="grow provenance">
            From {b.sender.displayName} · {formatDuration(b.journeyDurationMs)} at sea
          </span>
          <button
            type="button"
            className="btn-ghost"
            aria-pressed={readable}
            onClick={() => setReadable((r) => !r)}
            aria-label="Readable Print"
          >
            <Icon name="readable-print" size={14} />
            Aa
          </button>
        </div>
        <div className="letter-modal-scroll">
          <LetterPaper
            text={letter.letter.text}
            font={letter.letter.font}
            aging={letter.aging}
            readable={readable}
            toolbar="none"
          />
        </div>
        <p className="letter-modal-foot letter-chrome">
          {justOpened ? 'Opening ended its journey. ' : ''}Fonts and aging change the look only,
          never the words.
        </p>
      </div>
    </div>,
    document.body,
  );
}
