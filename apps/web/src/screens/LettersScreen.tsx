import { api } from '../api/client.js';
import { LetterPaper } from '../components/LetterPaper.js';
import { Empty, ErrorNote, Loading, Screen, StatusPill } from '../components/ui.js';
import { formatDate, formatDuration } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';

export function LettersScreen({
  passportId,
  onSelect,
  onBack,
}: {
  passportId: string | null;
  onSelect: (id: string) => void;
  onBack: () => void;
}) {
  if (passportId) return <PassportView key={passportId} id={passportId} onBack={onBack} />;
  return <SentHistory onSelect={onSelect} />;
}

function SentHistory({ onSelect }: { onSelect: (id: string) => void }) {
  const sent = useAsync(() => api.sentBottles(), []);
  const list = sent.data?.bottles ?? [];
  return (
    <Screen title="My Letters · Sent">
      {sent.loading ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty>Nothing sent yet.</Empty>
      ) : (
        <ul className="list">
          {list.map((b) => (
            <li key={b.id}>
              <button className="list-item as-button" onClick={() => onSelect(b.id)}>
                <span>
                  <strong>To {b.recipient.displayName}</strong>
                  <span className="muted small block">{formatDate(b.releasedAt)}</span>
                </span>
                <StatusPill state={b.state} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">Received archive is proposed (D04) and not part of this stage.</p>
      <ErrorNote error={sent.error} />
    </Screen>
  );
}

function PassportView({ id, onBack }: { id: string; onBack: () => void }) {
  const res = useAsync(() => api.sentBottle(id), [id], 15_000);
  const b = res.data?.bottle;
  return (
    <Screen
      title="Bottle passport"
      actions={
        <button className="btn small" onClick={onBack}>
          Back
        </button>
      }
    >
      {res.loading || !b ? (
        <Loading />
      ) : (
        <>
          <div className="row space-between">
            <strong>To {b.recipient.displayName}</strong>
            <StatusPill state={b.state} />
          </div>
          <dl className="passport">
            <dt>Released</dt>
            <dd>{formatDate(b.releasedAt)}</dd>
            <dt>Origin shore</dt>
            <dd>{b.originShore.name}</dd>
            <dt>Destination shore</dt>
            <dd>{b.destinationShore.name}</dd>
            <dt>Elapsed</dt>
            <dd>
              {formatDuration(b.elapsedMs)} {b.elapsedIsLive ? '(live)' : '(completed)'}
            </dd>
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
          <h2>Journey history</h2>
          <ol className="timeline">
            {b.events.map((e) => (
              <li key={e.seq}>
                <span className="muted small">{formatDate(e.occurredAt)}</span> {eventLabel(e.type)}
              </li>
            ))}
          </ol>
          <h2>Your letter</h2>
          <LetterPaper text={b.letter.text} font={b.letter.font} />
        </>
      )}
      <ErrorNote error={res.error} />
    </Screen>
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
