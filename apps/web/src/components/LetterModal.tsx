import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OpenedLetterDto } from '@mib/shared';
import { api } from '../api/client.js';
import { Icon } from '../design/Icon.js';
import { focusableIn } from '../lib/focusTrap.js';
import { restoreFocus, useModalKeys } from '../lib/modal.js';
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
  // A finder may block the anonymous writer during the reading (product decision 12).
  const [blockStage, setBlockStage] = useState<'idle' | 'confirm' | 'busy' | 'done' | 'failed'>(
    'idle',
  );
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
      restoreFocus(previous);
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

  useModalKeys(dialogRef, close);

  return createPortal(
    <div className={`letter-modal${closing ? ' closing' : ''}`}>
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
          {oneTime && (blockStage === 'idle' || blockStage === 'failed') ? (
            <button
              type="button"
              className="btn-ghost"
              aria-label="Block the writer"
              onClick={() => setBlockStage('confirm')}
            >
              Block
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
        {blockStage === 'confirm' || blockStage === 'busy' ? (
          <div className="letter-chrome letter-modal-report stack" role="group" aria-label="Block">
            <p className="secondary">
              Block the writer of this bottle? You will not see their bottles in the public ocean,
              and neither of you can send the other bottles. You will not be told who they are, and
              they will not be told you blocked them.
            </p>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="btn-ghost"
                disabled={blockStage === 'busy'}
                onClick={() => setBlockStage('idle')}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-destructive"
                disabled={blockStage === 'busy'}
                onClick={() => {
                  setBlockStage('busy');
                  api
                    .blockFoundWriter(b.id)
                    .then(() => setBlockStage('done'))
                    .catch(() => setBlockStage('failed'));
                }}
              >
                Block writer
              </button>
            </div>
          </div>
        ) : null}
        {blockStage === 'done' || blockStage === 'failed' ? (
          <p className="letter-chrome letter-modal-report t-meta" role="status">
            {blockStage === 'done'
              ? 'Writer blocked. You can undo this in Settings → Blocked users.'
              : 'Could not block right now. Try again.'}
          </p>
        ) : null}
        {reported ? (
          <p className="letter-chrome letter-modal-report t-meta" role="status">
            Thank you. Your report has been sent for review.
          </p>
        ) : null}
        {/* Focusable so a keyboard can scroll a long letter (audit A11Y-001). */}
        <div className="letter-modal-scroll" role="region" aria-label="Letter" tabIndex={0}>
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
            ? 'This bottle has left the public map. This is your one reading: it is not saved to your letters and gives no contact with the writer. If the page reloads you can return to it for 15 minutes; closing the letter ends it. You can still report or block from here. '
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
