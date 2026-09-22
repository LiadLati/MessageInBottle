import { SupportLink } from '../components/SupportLink.js';
import type { AccountStandingDto, ViolationNoticeDto } from '@mib/shared';
import { REPORT_REASON_LABELS } from '../components/ReportSheet.js';
import { BackButton, DeckScreen } from '../components/ui.js';
import { formatDate, formatDayTime } from '../lib/format.js';
import { useSession } from '../state/session.js';

interface Props {
  standing: AccountStandingDto;
  // Present when reached from the profile (the account is usable); absent when the screen is
  // the whole app, i.e. the account is suspended or banned.
  onBack?: (() => void) | undefined;
}

// Account standing (spec §16): every accepted violation, what it means, and one appeal each.
// A suspended or banned account sees nothing but this screen — and can still sign out.
export function StandingScreen({ standing, onBack }: Props) {
  const { logout } = useSession();
  const blocked = standing.standing === 'suspended' || standing.standing === 'banned';
  const headline =
    standing.standing === 'banned'
      ? 'Your account is permanently banned'
      : standing.standing === 'suspended'
        ? 'Your account is suspended'
        : standing.standing === 'warned'
          ? 'Your account has a warning'
          : 'Your account is in good standing';
  return (
    <DeckScreen
      title="Account standing"
      subtitle={headline}
      actions={
        onBack ? (
          <BackButton onClick={onBack} />
        ) : (
          <div className="row" style={{ gap: 8 }}>
            <SupportLink className="btn-ghost" />
            <button type="button" className="btn-ghost" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        )
      }
    >
      <div className="stack">
        <div className={`glass-panel stack standing-card standing-${standing.standing}`}>
          {standing.standing === 'suspended' ? (
            <>
              <p className="secondary">
                Two of your letters were reported and, after review, removed. Your account is
                suspended until <strong>{formatDayTime(standing.suspendedUntil!)}</strong>.
              </p>
              <p className="note amber">Another accepted violation means a permanent ban.</p>
            </>
          ) : standing.standing === 'banned' ? (
            <p className="secondary">
              Three of your letters were reported and, after review, removed. This account can no
              longer write, receive or read letters. You can still appeal each decision below.
            </p>
          ) : standing.standing === 'warned' ? (
            <p className="secondary">
              A letter of yours was reported and removed after review. A second accepted violation
              suspends the account for seven days; a third bans it permanently.
            </p>
          ) : (
            <p className="secondary">No violations are in force on this account.</p>
          )}
          {blocked ? (
            <p className="t-meta">
              While {standing.standing}, you can read this page, appeal, and sign out.
            </p>
          ) : null}
        </div>
        {standing.violations.length > 0 ? (
          <section className="stack">
            <h2 className="section-title">Decisions about your letters</h2>
            <ul className="list">
              {standing.violations.map((v) => (
                <ViolationRow key={v.id} violation={v} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </DeckScreen>
  );
}

// History, not an action. The single appeal is offered by the decision notice and nowhere
// else — the server opens it when the notice is presented — so this row reports where each
// decision stands and never gives a second way in.
function ViolationRow({ violation: v }: { violation: ViolationNoticeDto }) {
  const status = v.revokedAt
    ? 'Withdrawn after your appeal'
    : v.appeal?.status === 'pending'
      ? 'Appeal under review'
      : v.appeal?.status === 'rejected'
        ? 'Appeal rejected — final'
        : v.appealWaivedAt
          ? 'You chose not to appeal'
          : v.appealAvailable
            ? 'Awaiting your decision'
            : 'In force';
  return (
    <li className="row-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="row between">
        <span className="grow">
          <span className="t-card-title" style={{ display: 'block' }}>
            Letter to {v.bottle.recipientDisplayName} · {REPORT_REASON_LABELS[v.category]}
            {v.severity === 'critical' ? ' · critical child safety' : ''}
          </span>
          <span className="t-meta">
            Released {formatDate(v.bottle.releasedAt)} · decided {formatDate(v.decidedAt)} ·{' '}
            {status}
          </span>
        </span>
      </div>
      {v.appeal ? (
        <p className="t-meta" style={{ marginTop: 8 }}>
          Your appeal ({formatDate(v.appeal.createdAt)}): “{v.appeal.text}”
        </p>
      ) : null}
    </li>
  );
}
