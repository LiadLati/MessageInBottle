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
  // A finder's one reading of a bottle found adrift. Closing it only hides it: the reading stays
  // open on the server for the rest of its 15 minutes and can be returned to. Only an explicit,
  // confirmed "Finish reading" ends it early (`onFinish`).
  oneTime?: boolean;
  onFinish?: (() => void) | undefined;
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
  onFinish,
}: Props) {
  const [readable, setReadable] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState<'kept' | null>(null);
  // A finder may block the anonymous writer during the reading (product decision 12).
  const [blockStage, setBlockStage] = useState<'idle' | 'confirm' | 'busy' | 'done' | 'failed'>(
    'idle',
  );
  const [confirmingFinish, setConfirmingFinish] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const finishRef = useRef<HTMLButtonElement>(null);
  const keepReadingRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const finishTextId = useId();
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

  const leave = (then: () => void) => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(then, prefersReducedMotion() ? CLOSE_MS_REDUCED : CLOSE_MS);
  };
  // Closes the reader. For a one-time reading this only hides it (FE-R-002): a stray tap on the
  // backdrop or Escape never ends the reading.
  const close = () => leave(onClose);
  const finish = () => leave(onFinish ?? onClose);
  // Backing out returns focus to "Finish reading", once the footer holding it is back.
  const refocusFinish = useRef(false);
  const cancelFinish = () => {
    refocusFinish.current = true;
    setConfirmingFinish(false);
  };
  useEffect(() => {
    if (confirmingFinish) keepReadingRef.current?.focus();
    else if (refocusFinish.current) {
      refocusFinish.current = false;
      finishRef.current?.focus();
    }
  }, [confirmingFinish]);
  const reportDone = ({ hidden }: { hidden: boolean }) => {
    setReporting(false);
    if (hidden) {
      onHidden?.();
      close();
    } else {
      setReported('kept');
    }
  };

  // Escape backs out of the finish confirmation first, and otherwise only closes the reader.
  useModalKeys(dialogRef, confirmingFinish ? cancelFinish : close);
  const panelOpen =
    reporting || blockStage === 'confirm' || blockStage === 'busy' || confirmingFinish;

  return createPortal(
    <div className={`letter-modal${closing ? ' closing' : ''}`}>
      <div className="letter-modal-backdrop" onClick={close} aria-hidden />
      {justOpened && !closing ? <div className="veil" aria-hidden /> : null}
      <div
        ref={dialogRef}
        className={`letter-modal-dialog${panelOpen ? ' has-panel' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="letter-modal-top letter-chrome">
          <button type="button" className="btn-ghost" onClick={close}>
            <Icon name="back" size={14} />
            {oneTime ? 'Close for now' : 'Back to shore'}
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
        {confirmingFinish ? (
          <div
            className="letter-chrome letter-modal-report stack"
            role="group"
            aria-label="Finish reading"
            aria-describedby={finishTextId}
          >
            <p id={finishTextId} className="secondary">
              Finish your one reading now? The letter closes for good: you will not be able to open
              it again, and nobody else can find it.
            </p>
            <div className="row report-actions" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button
                ref={keepReadingRef}
                type="button"
                className="btn-ghost"
                onClick={cancelFinish}
              >
                Keep reading
              </button>
              <button type="button" className="btn-destructive" onClick={finish}>
                Finish reading
              </button>
            </div>
          </div>
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
        {/* Out of the way while a panel needs the room, and out of the Tab order with it. */}
        {panelOpen ? null : (
          <p className="letter-modal-foot letter-chrome">
            {oneTime
              ? 'This bottle has left the public map. This is your one reading: it is not saved to your letters and gives no contact with the writer. If you close it or the page reloads, you can return to it for 15 minutes from when you opened it. You can still report or block from here. '
              : justOpened
                ? 'Opening ended its journey. '
                : ''}
            Fonts and aging change the look only, never the words.
            {oneTime ? (
              <>
                {' '}
                <button
                  ref={finishRef}
                  type="button"
                  className="btn-ghost letter-modal-finish"
                  onClick={() => setConfirmingFinish(true)}
                >
                  Finish reading
                </button>
              </>
            ) : null}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
