import { useState, type ReactNode } from 'react';
import type { OpenedLetterDto, SentBottleSummaryDto } from '@mib/shared';
import { api } from '../api/client.js';
import { LetterModal } from '../components/LetterModal.js';
import { LetterPaper } from '../components/LetterPaper.js';
import {
  Avatar,
  BackButton,
  DeckScreen,
  ErrorNote,
  OutcomeChip,
  Skeleton,
  StatusChip,
} from '../components/ui.js';
import { Icon } from '../design/Icon.js';
import { formatDate, formatDuration } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';

interface Props {
  passportId: string | null;
  onSelect: (id: string) => void;
  onBack: () => void;
  // Letters → Lost → "Show on public map": switch the Ocean to public mode on this bottle.
  onShowPublic: (id: string) => void;
}

type Folder = 'sent' | 'received' | 'lost';
const FOLDER_LABELS: Record<Folder, string> = { sent: 'Sent', received: 'Received', lost: 'Lost' };

export function LettersScreen({ passportId, onSelect, onBack, onShowPublic }: Props) {
  const [folder, setFolder] = useState<Folder>('sent');
  if (passportId) return <PassportView key={passportId} id={passportId} onBack={onBack} />;
  const tabs = (
    <div className="seg-tabs" role="tablist" aria-label="Letters">
      {(['sent', 'received', 'lost'] as const).map((f) => (
        <button
          key={f}
          type="button"
          role="tab"
          id={`letters-tab-${f}`}
          aria-selected={folder === f}
          aria-controls={`letters-panel-${f}`}
          className={folder === f ? 'active' : ''}
          onClick={() => setFolder(f)}
        >
          {FOLDER_LABELS[f]}
        </button>
      ))}
    </div>
  );
  return folder === 'sent' ? (
    <SentHistory onSelect={onSelect} tabs={tabs} />
  ) : folder === 'lost' ? (
    <LostHistory onSelect={onSelect} onShowPublic={onShowPublic} tabs={tabs} />
  ) : (
    <ReceivedHistory tabs={tabs} />
  );
}

function SentHistory({ onSelect, tabs }: { onSelect: (id: string) => void; tabs: ReactNode }) {
  const sent = useAsync(() => api.sentBottles(), []);
  // Letters the sea ended live under Lost; everything else stays here with its fate.
  const list = (sent.data?.bottles ?? []).filter((b) => b.state !== 'lost');
  return (
    <DeckScreen title="Letters" subtitle="Everything you have sent, with its fate">
      {tabs}
      <div
        id="letters-panel-sent"
        role="tabpanel"
        aria-labelledby="letters-tab-sent"
        className="stack"
      >
        {sent.loading && !sent.data ? (
          <Skeleton />
        ) : list.length === 0 ? (
          <div className="glass-panel stack">
            <h2 className="t-display-sm">Nothing sent yet</h2>
            <p className="secondary">Your sent bottles and their passports will gather here.</p>
          </div>
        ) : (
          <ul className="list">
            {list.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  className="row-item selectable"
                  onClick={() => onSelect(b.id)}
                >
                  <Avatar name={b.recipient.displayName} tone="foam" />
                  <span className="grow">
                    <span className="t-card-title" style={{ display: 'block' }}>
                      To {b.recipient.displayName}
                    </span>
                    <span className="t-meta">
                      Released {formatDate(b.releasedAt)} · {formatDuration(b.elapsedMs)}
                    </span>
                  </span>
                  <StatusChip state={b.state} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <ErrorNote error={sent.error} />
      </div>
    </DeckScreen>
  );
}

// Letters → Lost: journeys the sea ended, with the outcome stated in words. The sender keeps
// the letter and the passport; an adrift bottle can be shown on the public map.
function LostHistory({
  onSelect,
  onShowPublic,
  tabs,
}: {
  onSelect: (id: string) => void;
  onShowPublic: (id: string) => void;
  tabs: ReactNode;
}) {
  const sent = useAsync(() => api.sentBottles(), []);
  const list = (sent.data?.bottles ?? []).filter(
    (b): b is SentBottleSummaryDto & { outcome: NonNullable<SentBottleSummaryDto['outcome']> } =>
      b.state === 'lost' && b.outcome !== null,
  );
  return (
    <DeckScreen title="Letters" subtitle="Journeys the sea ended">
      {tabs}
      <div
        id="letters-panel-lost"
        role="tabpanel"
        aria-labelledby="letters-tab-lost"
        className="stack"
      >
        {sent.loading && !sent.data ? (
          <Skeleton />
        ) : sent.error && !sent.data ? null : list.length === 0 ? (
          <div className="glass-panel stack">
            <h2 className="t-display-sm">Nothing lost</h2>
            <p className="secondary">
              Every bottle you have released is still on its way, or has arrived.
            </p>
          </div>
        ) : (
          <ul className="list">
            {list.map((b) => (
              <li key={b.id} className="row-item lost-row">
                <Avatar name={b.recipient.displayName} tone="foam" />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="t-card-title" style={{ display: 'block' }}>
                    To {b.recipient.displayName}
                  </span>
                  <span className="t-meta" style={{ display: 'block' }}>
                    {b.outcome.reason === 'sunk' ? 'Sank' : 'Lost'} {formatDate(b.outcome.at)} ·
                    released {formatDate(b.releasedAt)}
                  </span>
                  <span className="lost-actions">
                    <OutcomeChip reason={b.outcome.reason} />
                    <button
                      type="button"
                      className="btn-ghost small"
                      onClick={() => onSelect(b.id)}
                    >
                      <Icon name="passport" size={14} />
                      Passport
                    </button>
                    {b.outcome.reason === 'adrift' && b.publicListing?.status === 'listed' ? (
                      <button
                        type="button"
                        className="btn-ghost small"
                        onClick={() => onShowPublic(b.id)}
                      >
                        <Icon name="ocean" size={14} />
                        Show on public map
                      </button>
                    ) : b.outcome.reason === 'adrift' && b.publicListing?.status === 'opened' ? (
                      <span className="t-meta listing-status">Opened by a finder</span>
                    ) : b.outcome.reason === 'adrift' && b.publicListing?.status === 'expired' ? (
                      <span className="t-meta listing-status">
                        Removed from the public map after 72 hours
                      </span>
                    ) : null}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <ErrorNote error={sent.error} />
      </div>
    </DeckScreen>
  );
}

// Letters → Received: every letter the user has opened. Reading again is a plain read of the
// stored letter in the same modal the shore uses; nothing here changes state.
function ReceivedHistory({ tabs }: { tabs: ReactNode }) {
  const received = useAsync(() => api.receivedLetters(), []);
  const [reading, setReading] = useState<OpenedLetterDto | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const list = received.data?.letters ?? [];
  const read = async (id: string) => {
    setError(null);
    try {
      setReading(await api.readLetter(id));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };
  return (
    <DeckScreen title="Letters" subtitle="Letters that reached you, and bottles you found adrift">
      {tabs}
      <div
        id="letters-panel-received"
        role="tabpanel"
        aria-labelledby="letters-tab-received"
        className="stack"
      >
        {received.loading && !received.data ? (
          <Skeleton />
        ) : list.length === 0 ? (
          <div className="glass-panel stack">
            <h2 className="t-display-sm">Nothing opened yet</h2>
            <p className="secondary">
              Letters you pick up on your shore — and bottles you open in the public ocean — are
              kept here.
            </p>
          </div>
        ) : (
          <ul className="list">
            {list.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  className="row-item selectable"
                  onClick={() => void read(b.id)}
                >
                  {/* A bottle found adrift carries no attribution: the public ocean never names
                      a sender or a shore, and opening one does not change that. */}
                  {b.sender ? (
                    <Avatar name={b.sender.displayName} />
                  ) : (
                    <span className="avatar glass pennant-avatar" aria-hidden>
                      ⚑
                    </span>
                  )}
                  <span className="grow">
                    <span className="t-card-title" style={{ display: 'block' }}>
                      {b.sender ? `From ${b.sender.displayName}` : 'Found adrift'}
                    </span>
                    <span className="t-meta">
                      Opened {b.openedAt ? formatDate(b.openedAt) : '—'} ·{' '}
                      {b.originShore ? `from ${b.originShore.name} · ` : ''}
                      {formatDuration(b.journeyDurationMs)} at sea
                    </span>
                  </span>
                  <span className="t-meta">Read</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <ErrorNote error={error ?? received.error} />
      </div>
      {reading ? (
        <LetterModal letter={reading} justOpened={false} onClose={() => setReading(null)} />
      ) : null}
    </DeckScreen>
  );
}

function PassportView({ id, onBack }: { id: string; onBack: () => void }) {
  const res = useAsync(() => api.sentBottle(id), [id], 15_000);
  const b = res.data?.bottle;
  return (
    <DeckScreen title="Bottle passport" actions={<BackButton onClick={onBack} />}>
      {res.loading || !b ? (
        <Skeleton />
      ) : (
        <>
          <div className="glass-panel stack">
            <div className="row between">
              <div className="row">
                <Avatar name={b.recipient.displayName} tone="foam" />
                <div>
                  <div className="t-card-title">To {b.recipient.displayName}</div>
                  <div className="t-meta">
                    {b.originShore.name} → {b.destinationShore.name}
                  </div>
                </div>
              </div>
              {b.outcome ? (
                <OutcomeChip reason={b.outcome.reason} />
              ) : (
                <StatusChip state={b.state} />
              )}
            </div>
            <dl className="passport-grid">
              <dt>Released</dt>
              <dd>{formatDate(b.releasedAt)}</dd>
              <dt>{b.elapsedIsLive ? 'At sea for' : 'Total voyage'}</dt>
              <dd>{formatDuration(b.elapsedMs)}</dd>
              <dt>Passages</dt>
              <dd>{Math.max(1, b.route.nodeIds.length - 1)}</dd>
              <dt>Storms</dt>
              <dd>None</dd>
              {b.deliveredAt ? (
                <>
                  <dt>Arrived</dt>
                  <dd>{formatDate(b.deliveredAt)}</dd>
                </>
              ) : null}
              {b.openedAt ? (
                <>
                  <dt>Opened</dt>
                  <dd>{formatDate(b.openedAt)}</dd>
                </>
              ) : null}
              {b.outcome ? (
                <>
                  <dt>{b.outcome.reason === 'sunk' ? 'Sank' : 'Adrift since'}</dt>
                  <dd>{formatDate(b.outcome.at)}</dd>
                </>
              ) : null}
            </dl>
            {b.outcome ? (
              <p className="t-meta">
                {b.outcome.reason === 'sunk'
                  ? `It went down in a storm on the way to ${b.recipient.displayName}. The letter never arrived; it is kept here.`
                  : `It was swept off course in a storm on the way to ${b.recipient.displayName} and now drifts in the public ocean. The letter never arrived; it is kept here.`}
              </p>
            ) : null}
            {b.state === 'delivered' ? (
              <p className="t-meta">
                Waiting for {b.recipient.displayName} to open it. Your words stay sealed until then.
              </p>
            ) : null}
          </div>
          <div className="glass-panel stack">
            <h2 className="t-label">Journey history</h2>
            <ol className="timeline">
              {b.events.map((e) => (
                <li key={e.seq}>
                  <span>
                    <span className="t-meta" style={{ display: 'block' }}>
                      {formatDate(e.occurredAt)}
                    </span>
                    {eventLabel(e.type, e.payload)}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <h2 className="section-title">Your letter</h2>
          <LetterPaper text={b.letter.text} font={b.letter.font} />
        </>
      )}
      <ErrorNote error={res.error} />
    </DeckScreen>
  );
}

function eventLabel(type: string, payload: Record<string, unknown> = {}): string {
  if (type === 'lost') {
    return payload.reason === 'sunk'
      ? 'Went down in a storm — lost at sea'
      : payload.reason === 'adrift'
        ? 'Swept off course in a storm — adrift in the public ocean'
        : 'Lost at sea';
  }
  const labels: Record<string, string> = {
    released: 'Released into the sea',
    delivered: 'Washed up on the destination shore',
    opened: 'Opened by the recipient — journey complete',
    cancelled: 'Delivery unavailable — journey ended',
    stranded: 'Stranded on an island',
    rescued: 'Rescued and back at sea',
    lost: 'Lost at sea',
    discarded: 'Discarded',
    storm_exposure: 'Caught in a storm',
    route_revised: 'Route revised',
    public_expired: 'Public listing expired',
  };
  return labels[type] ?? type;
}
