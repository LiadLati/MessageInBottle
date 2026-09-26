import { useEffect, useRef, useState } from 'react';
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
  // Offered on the restricted screen: the Terms promise a suspended or banned account can
  // still delete itself (FE-019).
  onDeleteAccount?: (() => void) | undefined;
  // A suspension's end has passed on this device's clock: ask the server again. The server's
  // clock decides; this only saves waiting for the next poll.
  onSuspensionEnded?: (() => void) | undefined;
}

// Time left in a suspension, to the minute. Display only: when it reaches zero the server is
// asked, and the account opens again only if the server agrees.
function useCountdown(until: string | null, onEnd?: () => void): string | null {
  const [now, setNow] = useState(() => Date.now());
  const end = until ? Date.parse(until) : null;
  useEffect(() => {
    if (end === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [end]);
  const left = end === null ? null : Math.max(0, end - now);
  const ended = left === 0;
  // Once per suspension end, however often the parent re-renders; then the regular poll takes
  // over if the server's clock has not got there yet.
  const asked = useRef<number | null>(null);
  const endRef = useRef(onEnd);
  useEffect(() => {
    endRef.current = onEnd;
  }, [onEnd]);
  useEffect(() => {
    if (!ended || end === null || asked.current === end) return;
    asked.current = end;
    endRef.current?.();
  }, [ended, end]);
  if (left === null) return null;
  const mins = Math.ceil(left / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Account standing (spec §16): every accepted violation, what it means, and one appeal each.
// A suspended or banned account sees nothing but this screen — and can still sign out.
export function StandingScreen({ standing, onBack, onDeleteAccount, onSuspensionEnded }: Props) {
  const { logout } = useSession();
  const inForce = standing.violations.filter((v) => v.revokedAt === null);
  const critical = inForce.some((v) => v.severity === 'critical');
  // The reason is the rule the most recent upheld decision found broken.
  const latest = [...inForce].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
  const reason = latest ? REPORT_REASON_LABELS[latest.category].toLowerCase() : null;
  const countdown = useCountdown(
    standing.standing === 'suspended' ? standing.suspendedUntil : null,
    onSuspensionEnded,
  );
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
          // Wraps at phone width, so Sign out is never pushed off the screen.
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <SupportLink className="btn-ghost" />
            {onDeleteAccount ? (
              <button type="button" className="btn-ghost" onClick={onDeleteAccount}>
                Delete account
              </button>
            ) : null}
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
                Two of your letters were reported and, after review by a person, removed
                {reason ? (
                  <>
                    {' '}
                    — most recently for <strong>{reason}</strong>
                  </>
                ) : null}
                . Your account is suspended until{' '}
                <strong>{formatDayTime(standing.suspendedUntil!)}</strong>.
              </p>
              {countdown ? (
                <p className="t-display-sm" role="timer" aria-label="Time left in the suspension">
                  {countdown} left
                </p>
              ) : null}
              <p className="secondary">
                While suspended you cannot send or receive bottles, and friends cannot find you.
                Your friendships are kept. Everything opens again automatically when the suspension
                ends.
              </p>
              <p className="note amber">Another upheld violation means a permanent ban.</p>
            </>
          ) : standing.standing === 'banned' ? (
            critical ? (
              <p className="secondary">
                A letter of yours was reviewed by a person and confirmed as a critical child-safety
                violation. Your account is permanently banned. It can no longer write, receive or
                read letters.
              </p>
            ) : (
              <p className="secondary">
                Three of your letters were reported and, after review by a person, removed
                {reason ? (
                  <>
                    {' '}
                    — most recently for <strong>{reason}</strong>
                  </>
                ) : null}
                . Your account is permanently banned. It can no longer write, receive or read
                letters.
              </p>
            )
          ) : standing.standing === 'warned' ? (
            <p className="secondary">
              A letter of yours was reported and removed after review. A second accepted violation
              suspends the account for seven days, and a third bans it permanently.
            </p>
          ) : (
            <p className="secondary">No violations are in force on this account.</p>
          )}
          {blocked ? (
            <p className="t-meta">
              While {standing.standing}, you can read this page, appeal a decision within its 30-day
              appeal period, get support, delete the account and sign out.
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
            ? `Appeal open until ${formatDate(v.appealDeadlineAt)}`
            : v.appealExpired
              ? 'Appeal period expired — final'
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
