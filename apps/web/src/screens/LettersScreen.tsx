import { useState, type ReactNode } from 'react';
import type { OpenedLetterDto } from '@mib/shared';
import { api } from '../api/client.js';
import { LetterModal } from '../components/LetterModal.js';
import { LetterPaper } from '../components/LetterPaper.js';
import {
  Avatar,
  BackButton,
  DeckScreen,
  ErrorNote,
  Skeleton,
  StatusChip,
} from '../components/ui.js';
import { formatDate, formatDuration } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';

interface Props {
  passportId: string | null;
  onSelect: (id: string) => void;
  onBack: () => void;
}

type Folder = 'sent' | 'received';

export function LettersScreen({ passportId, onSelect, onBack }: Props) {
  const [folder, setFolder] = useState<Folder>('sent');
  if (passportId) return <PassportView key={passportId} id={passportId} onBack={onBack} />;
  const tabs = (
    <div className="seg-tabs" role="tablist" aria-label="Letters">
      {(['sent', 'received'] as const).map((f) => (
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
          {f === 'sent' ? 'Sent' : 'Received'}
        </button>
      ))}
    </div>
  );
  return folder === 'sent' ? (
    <SentHistory onSelect={onSelect} tabs={tabs} />
  ) : (
    <ReceivedHistory tabs={tabs} />
  );
}

function SentHistory({ onSelect, tabs }: { onSelect: (id: string) => void; tabs: ReactNode }) {
  const sent = useAsync(() => api.sentBottles(), []);
  const list = sent.data?.bottles ?? [];
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
    <DeckScreen title="Letters" subtitle="Letters that reached you and were opened">
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
              Letters you pick up on your shore are kept here once opened.
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
                  <Avatar name={b.sender.displayName} />
                  <span className="grow">
                    <span className="t-card-title" style={{ display: 'block' }}>
                      From {b.sender.displayName}
                    </span>
                    <span className="t-meta">
                      Opened {b.openedAt ? formatDate(b.openedAt) : '—'} · from {b.originShore.name}{' '}
                      · {formatDuration(b.journeyDurationMs)} at sea
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
              <StatusChip state={b.state} />
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
            </dl>
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
                    {eventLabel(e.type)}
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

function eventLabel(type: string): string {
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
