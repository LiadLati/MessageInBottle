import { useState, type FormEvent } from 'react';
import { REPORT_REASONS, type ReportReason } from '@mib/shared';
import { api } from '../api/client.js';
import { ErrorNote } from './ui.js';

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  harassment: 'Harassment or threats',
  hate: 'Hate against a group',
  sexual: 'Sexual content',
  violence: 'Incitement to violence',
  self_harm: 'Encourages self-harm',
  spam: 'Spam or a scam',
  other: 'Something else',
};

interface Props {
  bottleId: string;
  // Called after a successful report; `hidden` says the reporter asked for the letter to go.
  onDone: (result: { hidden: boolean; alreadyReported: boolean }) => void;
  onCancel: () => void;
}

// Reporting a letter from inside the reader (spec §16). One request; the reporter chooses a
// reason, may explain, and may hide the letter for themselves at once. Nothing is scanned or
// judged here — the report opens a case that a person (helped by the local model) reviews.
export function ReportSheet({ bottleId, onDone, onCancel }: Props) {
  const [reason, setReason] = useState<ReportReason>('harassment');
  const [explanation, setExplanation] = useState('');
  const [hide, setHide] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.reportLetter({
        bottleId,
        reason,
        ...(explanation.trim() ? { explanation: explanation.trim() } : {}),
        hide,
      });
      onDone({ hidden: r.hidden, alreadyReported: r.alreadyReported });
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setBusy(false);
    }
  };

  return (
    <form
      className="report-sheet stack"
      onSubmit={(e) => void submit(e)}
      aria-label="Report this letter"
    >
      <h2 className="t-card-title">Report this letter</h2>
      <p className="t-meta">A reviewer will read it. The writer is never told who reported it.</p>
      <label className="field">
        <span className="t-label">Reason</span>
        <select
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value as ReportReason)}
          disabled={busy}
        >
          {REPORT_REASONS.map((r) => (
            <option key={r} value={r}>
              {REPORT_REASON_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="t-label">Explain, if you want to (optional)</span>
        <textarea
          className="input"
          rows={3}
          maxLength={1000}
          value={explanation}
          onChange={(e) => setExplanation(e.target.value)}
          disabled={busy}
        />
      </label>
      <label className="row" style={{ gap: 10 }}>
        <input
          type="checkbox"
          checked={hide}
          onChange={(e) => setHide(e.target.checked)}
          disabled={busy}
        />
        <span>Hide this letter from me right away</span>
      </label>
      <ErrorNote error={error} />
      <div className="row report-actions" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Sending…' : 'Send report'}
        </button>
      </div>
    </form>
  );
}
