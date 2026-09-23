import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  APPEAL_ACTION_APPEAL,
  APPEAL_ACTION_CONTINUE,
  APPEAL_ACTION_GO_BACK,
  APPEAL_ACTION_SKIP,
  APPEAL_WAIVER_CONFIRMATION,
  type ViolationNoticeDto,
} from '@mib/shared';
import { api } from '../api/client.js';
import { REPORT_REASON_LABELS } from './ReportSheet.js';
import { SupportLink } from './SupportLink.js';
import { ErrorNote } from './ui.js';
import { formatDate } from '../lib/format.js';
import { focusableIn } from '../lib/focusTrap.js';
import { useModalKeys } from '../lib/modal.js';

interface Props {
  notice: ViolationNoticeDto;
  // The notice was resolved (appealed or waived); reload standing.
  onResolved: () => Promise<void> | void;
}

// The decision notice, and the single appeal opportunity it carries.
//
// The whole point of this component is that it resolves *nothing* by being closed. There is no
// dismiss button, no backdrop click, no Escape: the only ways out are appealing and explicitly
// waiving, and both are server actions. If the person closes the tab, reloads, or loses the
// connection, the server still has an unresolved notice and hands it back on the next visit.
//
// Telling the server it is on screen (`presentDecision`) is what opens the appeal, so the
// offer is never counted as declined by someone who was never shown it.
type Stage = 'notice' | 'confirm-waiver' | 'appeal';

export function DecisionNotice({ notice, onResolved }: Props) {
  const [stage, setStage] = useState<Stage>('notice');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  // Answer-only: no Escape, but Tab stays inside even after focus falls to <body>.
  useModalKeys(ref, null);

  useEffect(() => {
    const siblings = [...document.body.children].filter((el) => el !== ref.current?.parentElement);
    for (const el of siblings) el.setAttribute('inert', '');
    return () => {
      for (const el of siblings) el.removeAttribute('inert');
    };
  }, []);
  // Focus moves to the dialog on each stage, so the confirmation is announced rather than
  // silently swapped in behind the pointer.
  useEffect(() => {
    (focusableIn(ref.current!)[0] ?? ref.current)?.focus();
  }, [stage]);
  // A best-effort report that the notice is visible. If it does not get through, nothing is
  // lost: the notice simply comes back.
  useEffect(() => {
    void api.presentDecision(notice.id).catch(() => {});
  }, [notice.id]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onResolved();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setBusy(false);
    }
  };

  const ladder =
    notice.severity === 'critical'
      ? 'This was classified as a confirmed critical child-safety violation, and your account is permanently banned.'
      : notice.ordinal <= 1
        ? 'This is a warning. A second upheld violation suspends your account for seven days; a third bans it permanently. Upheld violations stay counted unless an appeal reverses them.'
        : notice.ordinal === 2
          ? 'This is your second upheld violation, so your account is suspended for seven days. Serving the suspension does not remove it from the count: a third means a permanent ban.'
          : 'This is your third upheld violation, so your account is permanently banned.';

  return createPortal(
    <div className="confirm-layer">
      <div className="confirm-backdrop" aria-hidden />
      <div
        ref={ref}
        className="glass-panel confirm-dialog stack"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // The notice's paragraphs are the decision itself: announce them, not just the title
        // and the first control (audit A11Y-004).
        aria-describedby={stage === 'appeal' ? undefined : bodyId}
        tabIndex={-1}
      >
        {stage === 'notice' ? (
          <>
            <h2 id={titleId} className="t-display-sm">
              A decision about a letter you sent
            </h2>
            <div id={bodyId} className="stack">
              <p className="secondary">
                Your letter to {notice.bottle.recipientDisplayName}, released{' '}
                {formatDate(notice.bottle.releasedAt)}, was reported for{' '}
                <strong>{REPORT_REASON_LABELS[notice.category].toLowerCase()}</strong> and, after
                review by a person, removed for breaking the Community Rules.
              </p>
              <p className="secondary">{ladder}</p>
              <p className="secondary">
                You can appeal this decision once. Nothing is decided by closing this: it will be
                shown to you again until you choose.
              </p>
            </div>
            <ErrorNote error={error} />
            {/* Wraps at phone width: three actions do not fit on one 390px line, and a
                decision notice is the last place to hide a button off the edge. */}
            <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
              <SupportLink className="btn-ghost" />
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setStage('confirm-waiver')}
                  disabled={busy}
                >
                  {APPEAL_ACTION_CONTINUE}
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => setStage('appeal')}
                  disabled={busy}
                >
                  {APPEAL_ACTION_APPEAL}
                </button>
              </div>
            </div>
          </>
        ) : stage === 'confirm-waiver' ? (
          <>
            <h2 id={titleId} className="t-display-sm">
              {APPEAL_ACTION_CONTINUE}
            </h2>
            <p id={bodyId} className="note amber">
              {APPEAL_WAIVER_CONFIRMATION}
            </p>
            <ErrorNote error={error} />
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setStage('notice')}
                disabled={busy}
              >
                {APPEAL_ACTION_GO_BACK}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void run(() => api.waiveAppeal(notice.id))}
                disabled={busy}
              >
                {busy ? '…' : APPEAL_ACTION_SKIP}
              </button>
            </div>
          </>
        ) : (
          <form
            className="stack"
            aria-label="Appeal"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.submitAppeal(notice.id, text.trim()));
            }}
          >
            <h2 id={titleId} className="t-display-sm">
              {APPEAL_ACTION_APPEAL}
            </h2>
            <label className="field">
              <span className="t-label">
                Why should this decision be reconsidered? You can appeal once.
              </span>
              <textarea
                className="input"
                rows={5}
                maxLength={2000}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={busy}
              />
            </label>
            <ErrorNote error={error} />
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setStage('notice')}
                disabled={busy}
              >
                {APPEAL_ACTION_GO_BACK}
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={busy || text.trim().length === 0}
              >
                {busy ? 'Sending…' : 'Send appeal'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
