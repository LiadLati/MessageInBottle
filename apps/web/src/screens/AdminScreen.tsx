import { useState, type ReactNode } from 'react';
import type {
  AdminAppealDto,
  AdminCaseDetailDto,
  AdminCaseSummaryDto,
  ReportReason,
} from '@mib/shared';
import { api } from '../api/client.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { LetterPaper } from '../components/LetterPaper.js';
import { REPORT_REASON_LABELS } from '../components/ReportSheet.js';
import { Avatar, BackButton, DeckScreen, ErrorNote, Skeleton } from '../components/ui.js';
import { formatDate, formatDayTime } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';

export type AdminSection = 'reports' | 'appeals';
type Status = 'pending' | 'accepted' | 'rejected';
const STATUS_LABELS: Record<Status, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

interface Props {
  section: AdminSection;
  onSection: (s: AdminSection) => void;
  onBack: () => void;
}

// The admin console (spec §16 · moderation console): reports as cases, and appeals. Every list
// and every action here is answered by the server only for an admin account; the screen adds
// the explicit confirmation before each decision and records the reason with it.
export function AdminScreen({ section, onSection, onBack }: Props) {
  const [status, setStatus] = useState<Status>('pending');
  const [selected, setSelected] = useState<string | null>(null);
  const tabs = (
    <div className="row between" style={{ flexWrap: 'wrap', gap: 10 }}>
      <div className="seg-tabs" role="tablist" aria-label="Admin section">
        {(['reports', 'appeals'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={section === s}
            className={section === s ? 'active' : ''}
            onClick={() => {
              onSection(s);
              setSelected(null);
            }}
          >
            {s === 'reports' ? 'Reports' : 'Appeals'}
          </button>
        ))}
      </div>
      <div className="seg-tabs" role="tablist" aria-label="Status">
        {(['pending', 'accepted', 'rejected'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={status === s}
            className={status === s ? 'active' : ''}
            onClick={() => {
              setStatus(s);
              setSelected(null);
            }}
          >
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>
    </div>
  );
  return section === 'reports' ? (
    <ReportsSection
      status={status}
      tabs={tabs}
      selected={selected}
      onSelect={setSelected}
      onBack={onBack}
    />
  ) : (
    <AppealsSection
      status={status}
      tabs={tabs}
      selected={selected}
      onSelect={setSelected}
      onBack={onBack}
    />
  );
}

// ---------- reports ----------

function ReportsSection({
  status,
  tabs,
  selected,
  onSelect,
  onBack,
}: {
  status: Status;
  tabs: ReactNode;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onBack: () => void;
}) {
  const list = useAsync(() => api.adminCases(status), [status], 15_000);
  const cases = list.data?.cases ?? [];
  if (selected) {
    return (
      <CaseView
        id={selected}
        onBack={() => onSelect(null)}
        onChanged={async () => {
          await list.reload();
        }}
      />
    );
  }
  return (
    <DeckScreen
      title="Reports"
      subtitle="Reported letters, as cases"
      actions={<BackButton onClick={onBack} />}
      wide
    >
      {tabs}
      <div className="stack" aria-live="polite">
        {list.loading && !list.data ? (
          <Skeleton />
        ) : cases.length === 0 ? (
          <div className="glass-panel stack">
            <h2 className="t-display-sm">No {status} cases</h2>
          </div>
        ) : (
          <ul className="list" aria-label={`${STATUS_LABELS[status]} cases`}>
            {cases.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="row-item selectable"
                  onClick={() => onSelect(c.id)}
                >
                  <Avatar name={c.sender.displayName} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="t-card-title" style={{ display: 'block' }}>
                      {c.sender.displayName} → {c.intendedRecipient.displayName}
                      {c.context === 'public' ? ' · read by a finder' : ''}
                    </span>
                    <span className="t-meta">
                      {c.reportCount} {c.reportCount === 1 ? 'report' : 'reports'} ·{' '}
                      {c.reasons.map((r: ReportReason) => REPORT_REASON_LABELS[r]).join(', ')} ·{' '}
                      {formatDate(c.latestReportAt)}
                    </span>
                  </span>
                  <AiChip ai={c.ai} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <ErrorNote error={list.error} />
      </div>
    </DeckScreen>
  );
}

function AiChip({ ai }: { ai: AdminCaseSummaryDto['ai'] }) {
  const label =
    ai.status === 'done'
      ? ai.verdict === 'accept'
        ? 'AI: accept report'
        : ai.verdict === 'reject'
          ? 'AI: reject report'
          : 'AI: uncertain'
      : ai.status === 'running'
        ? 'AI: reviewing'
        : 'AI: waiting for model';
  const tone =
    ai.verdict === 'accept'
      ? 'status-lost'
      : ai.verdict === 'reject'
        ? 'status-delivered'
        : 'status-at_sea';
  return <span className={`status-chip ${tone}`}>{label}</span>;
}

function CaseView({
  id,
  onBack,
  onChanged,
}: {
  id: string;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const res = useAsync(() => api.adminCase(id), [id]);
  const [confirm, setConfirm] = useState<'accept' | 'reject' | 'critical' | 'hold' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const c = res.data?.case;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setConfirm(null);
      await Promise.all([res.reload(), onChanged()]);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };
  const decide = (reason: string) => {
    if (confirm !== 'accept' && confirm !== 'reject') return;
    const outcome = confirm;
    void act(() => api.adminDecideCase(id, outcome, reason));
  };
  return (
    <DeckScreen
      title="Report"
      subtitle={c ? `Case ${c.status}` : ''}
      actions={<BackButton onClick={onBack} />}
      wide
    >
      {res.loading || !c ? <Skeleton /> : <CaseBody c={c} />}
      {c?.status === 'pending' ? (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn-secondary" onClick={() => setConfirm('reject')}>
            Reject report
          </button>
          <button type="button" className="btn-destructive" onClick={() => setConfirm('accept')}>
            Accept report
          </button>
        </div>
      ) : null}
      {c && c.status !== 'rejected' && c.violation?.severity !== 'critical' ? (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn-destructive" onClick={() => setConfirm('critical')}>
            Confirmed critical child safety…
          </button>
        </div>
      ) : null}
      {c ? (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          {c.hold && c.hold.releasedAt === null ? (
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => void act(() => api.adminReleaseHold(id))}
            >
              Release {c.hold.reason === 'legal' ? 'legal' : 'child-safety'} hold
            </button>
          ) : c.retention.hold !== 'already_redacted' ? (
            <button type="button" className="btn-ghost" onClick={() => setConfirm('hold')}>
              Place a legal hold…
            </button>
          ) : null}
        </div>
      ) : null}
      <ErrorNote error={res.error} />
      {confirm && c ? (
        <ConfirmDialog
          title={confirm === 'accept' ? 'Accept this report?' : 'Reject this report?'}
          body={
            confirm === 'accept'
              ? `The letter from ${c.sender.displayName} will be removed from every reader and a violation recorded against their account (${c.sender.displayName} currently has ${violationWord(c)}). They will be told, but never who reported it.`
              : `The case will be closed with no violation. ${c.sender.displayName} will not be told anything.`
          }
          confirmLabel={confirm === 'accept' ? 'Accept report' : 'Reject report'}
          reasonLabel="Why (recorded with the decision)"
          destructive={confirm === 'accept'}
          busy={busy}
          error={error}
          onConfirm={(reason) => decide(reason)}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm === 'critical' && c ? (
        <ConfirmDialog
          title="Confirmed critical child-safety violation"
          body={`This permanently bans ${c.sender.displayName} immediately, without the usual warning and suspension steps, and withdraws the letter from every reader. It is recorded against your administrator account with the reason you give. ${c.sender.displayName} is shown the decision and may appeal it once.`}
          confirmLabel="Ban permanently"
          reasonLabel="Why (mandatory; recorded with your name and the time)"
          requireReason
          acknowledge="I have reviewed this case myself and confirm it is a critical child-safety violation."
          destructive
          busy={busy}
          error={error}
          onConfirm={(reason) => void act(() => api.adminDecideCritical(id, reason))}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm === 'hold' && c ? (
        <ConfirmDialog
          title="Keep this evidence beyond seven days"
          body="Content evidence is redacted seven days after a case becomes final. A hold keeps it while a documented legal or immediate child-safety reason requires it, and records why and who placed it. Releasing the hold returns the case to the ordinary calculation."
          confirmLabel="Place hold"
          reasonLabel="The documented reason (mandatory)"
          requireReason
          busy={busy}
          error={error}
          onConfirm={(note) => void act(() => api.adminPlaceHold(id, 'legal', note))}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </DeckScreen>
  );
}

function violationWord(_c: AdminCaseDetailDto): string {
  return 'a record you can check under Appeals';
}

// Sender, intended recipient or finder context, the original letter (evidence), every report
// with its reason and explanation, and the model's recommendation with its reasoning and doubt.
function CaseBody({ c }: { c: AdminCaseDetailDto }) {
  return (
    <div className="stack">
      <div className="glass-panel stack">
        <div className="row between">
          <div className="row">
            <Avatar name={c.sender.displayName} />
            <div>
              <div className="t-card-title">
                {c.sender.displayName} <span className="t-meta">@{c.sender.username}</span>
              </div>
              <div className="t-meta">
                to {c.intendedRecipient.displayName} (@{c.intendedRecipient.username}) · released{' '}
                {formatDate(c.releasedAt)}
                {c.context === 'public'
                  ? ' · lost at sea and read by a finder in the public ocean'
                  : ' · delivered to their shore'}
              </div>
            </div>
          </div>
          <AiChip ai={c.ai} />
        </div>
        {c.decision ? (
          <p className="note">
            <strong>
              {c.decision.outcome === 'accepted' ? 'Report accepted' : 'Report rejected'}
            </strong>{' '}
            by{' '}
            {c.decision.by === 'ai'
              ? 'the model (automatic)'
              : (c.decision.admin?.displayName ?? 'an admin')}{' '}
            on {formatDayTime(c.decision.at)}
            {c.decision.reason ? ` — “${c.decision.reason}”` : ''}
            {c.appeal ? ` · appeal ${c.appeal.status}` : ''}
          </p>
        ) : null}
      </div>

      <section className="stack">
        <h2 className="section-title">Original letter</h2>
        <div className="glass-panel">
          {c.letter.redactedAt ? (
            <p className="muted">
              The copy of this letter was removed on{' '}
              {new Date(c.letter.redactedAt).toLocaleDateString()} under the evidence retention
              policy. The decision and its reasoning are kept below.
            </p>
          ) : (
            <LetterPaper text={c.letter.text} font={c.letter.font} readable toolbar="none" />
          )}
        </div>
      </section>

      <section className="stack">
        <h2 className="section-title">
          {c.reports.length === 1 ? 'Report' : `${c.reports.length} reports`}
        </h2>
        <ul className="list">
          {c.reports.map((r) => (
            <li key={r.id} className="row-item" style={{ alignItems: 'flex-start' }}>
              <Avatar name={r.reporter.displayName} tone="foam" />
              <span className="grow">
                <span className="t-card-title" style={{ display: 'block' }}>
                  {REPORT_REASON_LABELS[r.reason]}
                </span>
                <span className="t-meta">
                  by {r.reporter.displayName} (@{r.reporter.username}) ·{' '}
                  {r.context === 'public' ? 'as a finder' : 'as the recipient'} ·{' '}
                  {formatDayTime(r.createdAt)}
                  {r.hidden ? ' · hid the letter' : ''}
                </span>
                {r.explanation ? (
                  <span className="secondary" style={{ display: 'block', marginTop: 6 }}>
                    “{r.explanation}”
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="stack">
        <h2 className="section-title">AI recommendation</h2>
        <div className="glass-panel stack">
          {c.ai.status === 'done' ? (
            <>
              <p>
                <strong>
                  {c.ai.verdict === 'accept'
                    ? 'Accept the report'
                    : c.ai.verdict === 'reject'
                      ? 'Reject the report'
                      : 'Uncertain — a person must decide'}
                </strong>
                {c.ai.model ? <span className="t-meta"> · {c.ai.model}</span> : null}
              </p>
              <p className="secondary">{c.ai.reason}</p>
              {c.ai.uncertainty ? (
                <p className="note amber">Why it is unsure: {c.ai.uncertainty}</p>
              ) : null}
              {c.ai.translation ? (
                <div className="stack">
                  <span className="t-label">
                    Translation{c.ai.language ? ` (from ${c.ai.language})` : ''} — the original is
                    above
                  </span>
                  <p className="secondary" dir="auto">
                    {c.ai.translation}
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            <p className="secondary">
              {c.ai.status === 'running'
                ? 'The model is reviewing this case.'
                : 'Waiting for the local model. The case stays in the queue until it answers; decide it yourself if you prefer.'}
              {c.ai.lastError ? ` Last attempt: ${c.ai.lastError}.` : ''}
              {c.ai.attempts > 0 ? ` ${c.ai.attempts} attempt(s).` : ''}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

// ---------- appeals ----------

function AppealsSection({
  status,
  tabs,
  selected,
  onSelect,
  onBack,
}: {
  status: Status;
  tabs: ReactNode;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onBack: () => void;
}) {
  const list = useAsync(() => api.adminAppeals(status), [status], 15_000);
  const appeals = list.data?.appeals ?? [];
  const current = selected ? (appeals.find((a) => a.id === selected) ?? null) : null;
  if (current) {
    return (
      <AppealView
        appeal={current}
        onBack={() => onSelect(null)}
        onChanged={async () => {
          await list.reload();
          onSelect(null);
        }}
      />
    );
  }
  return (
    <DeckScreen
      title="Appeals"
      subtitle="Decisions the writer asked to be reconsidered"
      actions={<BackButton onClick={onBack} />}
      wide
    >
      {tabs}
      <div className="stack" aria-live="polite">
        {list.loading && !list.data ? (
          <Skeleton />
        ) : appeals.length === 0 ? (
          <div className="glass-panel stack">
            <h2 className="t-display-sm">No {status} appeals</h2>
          </div>
        ) : (
          <ul className="list" aria-label={`${STATUS_LABELS[status]} appeals`}>
            {appeals.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="row-item selectable"
                  onClick={() => onSelect(a.id)}
                >
                  <Avatar name={a.appellant.displayName} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="t-card-title" style={{ display: 'block' }}>
                      {a.appellant.displayName} · {REPORT_REASON_LABELS[a.violation.category]}
                    </span>
                    <span className="t-meta">
                      Appealed {formatDate(a.createdAt)} · decided{' '}
                      {formatDate(a.violation.decidedAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <ErrorNote error={list.error} />
      </div>
    </DeckScreen>
  );
}

function AppealView({
  appeal: a,
  onBack,
  onChanged,
}: {
  appeal: AdminAppealDto;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<'accept' | 'reject' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const decide = async (reason: string) => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      await api.adminDecideAppeal(a.id, confirm, reason);
      setConfirm(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DeckScreen
      title="Appeal"
      subtitle={`Appeal ${a.status}`}
      actions={<BackButton onClick={onBack} />}
      wide
    >
      <div className="stack">
        <div className="glass-panel stack">
          <div className="row">
            <Avatar name={a.appellant.displayName} />
            <div className="grow">
              <div className="t-card-title">
                {a.appellant.displayName} <span className="t-meta">@{a.appellant.username}</span>
              </div>
              <div className="t-meta">Appealed {formatDayTime(a.createdAt)}</div>
            </div>
          </div>
          <p className="secondary" dir="auto">
            “{a.text}”
          </p>
          {a.decision ? (
            <p className="note">
              <strong>Appeal {a.decision.outcome}</strong> by {a.decision.admin.displayName} on{' '}
              {formatDayTime(a.decision.at)}
              {a.decision.reason ? ` — “${a.decision.reason}”` : ''}
            </p>
          ) : null}
        </div>
        <section className="stack">
          <h2 className="section-title">The original case</h2>
          <CaseBody c={a.case} />
        </section>
      </div>
      {a.status === 'pending' ? (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn-secondary" onClick={() => setConfirm('reject')}>
            Reject appeal
          </button>
          <button type="button" className="btn-primary" onClick={() => setConfirm('accept')}>
            Accept appeal
          </button>
        </div>
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={confirm === 'accept' ? 'Accept this appeal?' : 'Reject this appeal?'}
          body={
            confirm === 'accept'
              ? `The violation will be withdrawn, the letter restored to its readers, and ${a.appellant.displayName}'s standing recalculated — a suspension or ban that rested on it is lifted.`
              : `The decision stands. ${a.appellant.displayName} will be told, and cannot appeal it again.`
          }
          confirmLabel={confirm === 'accept' ? 'Accept appeal' : 'Reject appeal'}
          reasonLabel="Why (recorded with the decision)"
          destructive={confirm === 'reject'}
          busy={busy}
          error={error}
          onConfirm={(reason) => void decide(reason)}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </DeckScreen>
  );
}
