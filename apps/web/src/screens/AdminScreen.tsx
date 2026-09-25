import { useState, type ReactNode } from 'react';
import {
  countHiddenControls,
  revealHiddenControls,
  type AdminAppealDto,
  type AdminCaseDetailDto,
  type AdminCaseSummaryDto,
  type ReportReason,
} from '@mib/shared';
import { api } from '../api/client.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { TabList, tabId } from '../components/Tabs.js';
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
      <TabList
        base="admin-section"
        label="Admin section"
        items={['reports', 'appeals'] as const}
        selected={section}
        onSelect={(s) => {
          onSection(s);
          setSelected(null);
        }}
        labelOf={(s) => (s === 'reports' ? 'Reports' : 'Appeals')}
        controls={ADMIN_PANEL}
      />
      <TabList
        base="admin-status"
        label="Status"
        items={['pending', 'accepted', 'rejected'] as const}
        selected={status}
        onSelect={(s) => {
          setStatus(s);
          setSelected(null);
        }}
        labelOf={(s) => STATUS_LABELS[s]}
        controls={ADMIN_PANEL}
      />
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

// Both tab lists (section and status) control this one panel.
const ADMIN_PANEL = 'admin-panel';

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
      <div
        id={ADMIN_PANEL}
        role="tabpanel"
        aria-labelledby={`${tabId('admin-section', 'reports')} ${tabId('admin-status', status)}`}
        tabIndex={0}
        className="stack"
        aria-live="polite"
      >
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
                    {c.urgentAt ? (
                      <span style={{ display: 'block', marginTop: 6 }}>
                        <UrgentChip />
                      </span>
                    ) : null}
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

// A possible child-safety issue flagged by the model. It only moves the case up the queue:
// nothing is decided, sanctioned or banned until an administrator does it.
function UrgentChip() {
  return <span className="status-chip status-lost">Urgent · possible child safety</span>;
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
  const [confirm, setConfirm] = useState<
    'accept' | 'reject' | 'critical' | 'hold-legal' | 'hold-child' | null
  >(null);
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
    if (!c) return;
    const digest = c.evidenceDigest;
    void act(() => api.adminDecideCase(id, outcome, reason, digest));
  };
  return (
    <DeckScreen
      title="Report"
      subtitle={c ? `Case ${c.status}` : ''}
      actions={<BackButton onClick={onBack} />}
      wide
    >
      {res.loading || !c ? <Skeleton /> : <CaseBody c={c} />}
      {c?.recused ? (
        <p className="note amber" role="status">
          You are the sender, the recipient or a reporter on this case, so another administrator
          must decide it, its appeal and any critical classification.
        </p>
      ) : null}
      {/* The three decisions (product decision 2): reject, uphold an ordinary violation, or
          confirm a critical child-safety violation. Each is final; only the sender's own
          appeal can change it. An upheld ordinary case can still be escalated to critical. */}
      {c && !c.recused && (c.status === 'pending' || c.violation?.severity === 'standard') ? (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          {c.status === 'pending' ? (
            <>
              <button type="button" className="btn-secondary" onClick={() => setConfirm('reject')}>
                Reject report
              </button>
              <button
                type="button"
                className="btn-destructive"
                onClick={() => setConfirm('accept')}
              >
                Uphold · ordinary violation
              </button>
            </>
          ) : null}
          <button type="button" className="btn-destructive" onClick={() => setConfirm('critical')}>
            {c.status === 'pending'
              ? 'Confirm critical child safety…'
              : 'Escalate to critical child safety…'}
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
            <>
              <button type="button" className="btn-ghost" onClick={() => setConfirm('hold-legal')}>
                Place a legal hold…
              </button>
              <button type="button" className="btn-ghost" onClick={() => setConfirm('hold-child')}>
                Place a child-safety hold…
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <ErrorNote error={res.error} />
      {(confirm === 'accept' || confirm === 'reject') && c ? (
        <ConfirmDialog
          title={
            confirm === 'accept'
              ? 'Uphold this report as an ordinary violation?'
              : 'Reject this report?'
          }
          body={
            confirm === 'accept'
              ? `The letter from ${c.sender.displayName} will be removed from every reader and a violation recorded against their account. ${consequenceSentence(c)} They will be told, but never who reported it, and may appeal once within 30 days. ${FINAL}`
              : `The case will be closed with no violation. ${c.sender.displayName} will not be told anything. ${FINAL}`
          }
          confirmLabel={confirm === 'accept' ? 'Uphold violation' : 'Reject report'}
          reasonLabel="Why (mandatory; recorded with the decision)"
          requireReason
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
          body={`This PERMANENTLY BANS ${c.sender.displayName} IMMEDIATELY, without the usual warning and suspension steps, and withdraws the letter from every reader. It is recorded with your administrator account, the time, the classification and the reason you give. ${
            c.status === 'accepted'
              ? c.appeal
                ? `${c.sender.displayName} already appealed this decision, so no new appeal opens.`
                : `Escalating gives ${c.sender.displayName} one new appeal opportunity, within 30 days.`
              : `${c.sender.displayName} is shown the decision and may appeal it once, within 30 days.`
          } ${FINAL}`}
          confirmLabel="Ban permanently"
          reasonLabel="Why (mandatory; recorded with your name and the time)"
          requireReason
          acknowledge="I have reviewed this case myself and confirm it is a critical child-safety violation."
          destructive
          busy={busy}
          error={error}
          onConfirm={(reason) =>
            void act(() => api.adminDecideCritical(id, reason, c.evidenceDigest))
          }
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {(confirm === 'hold-legal' || confirm === 'hold-child') && c ? (
        <ConfirmDialog
          title={
            confirm === 'hold-legal'
              ? 'Place a legal hold on this evidence'
              : 'Place a child-safety hold on this evidence'
          }
          body="Content evidence is redacted 30 days after the decision, or once a timely appeal is decided if that is later. A hold keeps it for as long as a documented legal or child-safety reason requires, and records why, when and who placed it. Releasing the hold returns the case to the ordinary calculation."
          confirmLabel="Place hold"
          reasonLabel="The documented reason (mandatory)"
          requireReason
          busy={busy}
          error={error}
          onConfirm={(note) =>
            void act(() =>
              api.adminPlaceHold(id, confirm === 'hold-legal' ? 'legal' : 'child_safety', note),
            )
          }
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </DeckScreen>
  );
}

// Decision 1: one administrator, no second approval and no way to reopen or reverse.
const FINAL =
  'This decision is final: you cannot reopen or reverse it; only the sender’s appeal can change it.';

// What upholding does to the sender's standing, as the server computed it (audit FE-009).
function consequenceSentence(c: AdminCaseDetailDto): string {
  const name = c.sender.displayName;
  const prior = c.consequence.violationsInForce;
  const had =
    prior === 0
      ? `${name} has no violation in force`
      : `${name} already has ${prior} violation${prior === 1 ? '' : 's'} in force`;
  const result =
    c.consequence.ifUpheld === 'warning'
      ? 'so this one is a warning'
      : c.consequence.ifUpheld === 'suspension'
        ? 'so this one suspends the account for seven days'
        : 'so this one BANS the account permanently';
  return `${had}, ${result}. Upheld violations never expire.`;
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
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {c.urgentAt ? <UrgentChip /> : null}
            <AiChip ai={c.ai} />
          </div>
        </div>
        {c.urgentAt ? (
          <p className="note amber" role="note">
            The review model flagged a possible child-safety issue on {formatDayTime(c.urgentAt)},
            so this case is at the top of the queue. The model only recommends: you decide, and
            nothing has been sanctioned.
          </p>
        ) : null}
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
            <>
              <LetterPaper text={c.letter.text} font={c.letter.font} readable toolbar="none" />
              <HiddenControlsWarning text={c.letter.text} />
            </>
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
              {c.ai.childSafety ? (
                <p className="note amber">
                  Flagged as a possible child-safety issue. This is a recommendation, not a
                  classification.
                </p>
              ) : null}
              <p className="secondary">{c.ai.reason}</p>
              {c.ai.uncertainty ? (
                <p className="note amber">Why it is unsure: {c.ai.uncertainty}</p>
              ) : null}
              {c.ai.translation ? (
                <div className="stack">
                  <span className="t-label">
                    Machine translation{c.ai.language ? ` (from ${c.ai.language})` : ''} — produced
                    by the review model from text the sender wrote, so it can be wrong or
                    manipulated. The original above is the evidence.
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
      <div
        id={ADMIN_PANEL}
        role="tabpanel"
        aria-labelledby={`${tabId('admin-section', 'appeals')} ${tabId('admin-status', status)}`}
        tabIndex={0}
        className="stack"
        aria-live="polite"
      >
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
              ? `The violation will be withdrawn, the letter restored to its readers, and ${a.appellant.displayName}'s standing recalculated — a suspension or ban that rested on it is lifted. This is final.`
              : `The decision stands permanently. ${a.appellant.displayName} will be told, and cannot appeal it again. ${
                  a.case.violation?.severity === 'critical'
                    ? 'The account stays permanently banned.'
                    : consequenceNow(a)
                } This is final.`
          }
          confirmLabel={confirm === 'accept' ? 'Accept appeal' : 'Reject appeal'}
          reasonLabel="Why (mandatory; recorded with the decision)"
          requireReason
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

// What the violation keeps doing to the appellant's standing if the appeal is rejected.
function consequenceNow(a: AdminAppealDto): string {
  const n = a.case.consequence.violationsInForce;
  return n >= 3
    ? 'The account stays permanently banned.'
    : n === 2
      ? 'The violation keeps counting: the account has two in force (a suspension).'
      : 'The violation keeps counting against the account.';
}

// A letter can carry invisible bidirectional or zero-width controls, which make the rendered
// text read differently from what was written (audit SEC-018). The moderator is told, and is
// shown the text with each control made visible, before deciding on it.
function HiddenControlsWarning({ text }: { text: string }) {
  const count = countHiddenControls(text);
  if (count === 0) return null;
  return (
    <div className="note amber stack" role="note">
      <p>
        This letter contains{' '}
        {count === 1
          ? 'an invisible formatting character'
          : `${count} invisible formatting characters`}{' '}
        (text-direction or zero-width controls). They can make the text above read differently from
        what was written. Here it is with each one shown:
      </p>
      <pre className="revealed-text" dir="ltr" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
        {revealHiddenControls(text)}
      </pre>
    </div>
  );
}
