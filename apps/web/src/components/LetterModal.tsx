import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OpenedLetterDto } from '@mib/shared';
import { Icon } from '../design/Icon.js';
import { focusableIn, nextTabTarget } from '../lib/focusTrap.js';
import { formatDuration, prefersReducedMotion } from '../lib/format.js';
import { LetterPaper } from './LetterPaper.js';
import { ReportSheet } from './ReportSheet.js';

interface Props {
  letter: OpenedLetterDto;
  justOpened: boolean;
  // Overrides the provenance line. Used for a letter that carries no attribution — one found
  // adrift, or the sender re-reading their own.
  provenance?: string | undefined;
  // A finder's one reading of a bottle found adrift: says so, and that closing ends it.
  oneTime?: boolean;
  // Offered to a reader who holds the letter (its recipient, or the finder reading it once):
  // never to the sender reading their own. After a report that hides the letter, the reader
  // closes and `onHidden` lets the screen behind drop it.
  reportable?: boolean;
  onHidden?: (() => void) | undefined;
  onClose: () => void;
}

const CLOSE_MS = 260;
const CLOSE_MS_REDUCED = 120;

// S8 · Opened letter as a modal over the shore: the parchment floats with the shore visible
// around it and the navigation still drawn but inert. Proper dialog semantics: the rest of the
// app is `inert`, focus is trapped and restored, Escape closes, the page behind cannot scroll.
// Exactly two controls (Back to shore, Readable Print); text is selectable, dir="auto", and the
// stored words are rendered verbatim (storyboard §D).
export function LetterModal({
  letter,
  justOpened,
  provenance,
  oneTime = false,
  reportable = false,
  onHidden,
  onClose,
}: Props) {
  const [readable, setReadable] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState<'kept' | null>(null);
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
  const reportDone = ({ hidden }: { hidden: boolean }) => {
    setReporting(false);
    if (hidden) {
      onHidden?.();
      close();
    } else {
      setReported('kept');
    }
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
            {oneTime ? 'Close letter' : 'Back to shore'}
          </button>
          <span id={titleId} className="grow provenance">
            {provenance ??
              `${b.sender ? `From ${b.sender.displayName}` : 'Found adrift'} · ${formatDuration(
                b.journeyDurationMs,
              )} at sea`}
          </span>
          {reportable && !reported ? (
            <button
              type="button"
              className="btn-ghost"
              aria-pressed={reporting}
              aria-label="Report this letter"
              onClick={() => setReporting((r) => !r)}
            >
              <Icon name="report" size={14} />
              Report
            </button>
          ) : null}
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
        {reporting ? (
          <div className="letter-chrome letter-modal-report">
            <ReportSheet bottleId={b.id} onDone={reportDone} onCancel={() => setReporting(false)} />
          </div>
        ) : null}
        {reported ? (
          <p className="letter-chrome letter-modal-report t-meta" role="status">
            Thank you. Your report has been sent for review.
          </p>
        ) : null}
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
          {oneTime
            ? 'This bottle has left the public map. This is your one reading: closing the letter ends it. '
            : justOpened
              ? 'Opening ended its journey. '
              : ''}
          Fonts and aging change the look only, never the words.
        </p>
      </div>
    </div>,
    document.body,
  );
}
