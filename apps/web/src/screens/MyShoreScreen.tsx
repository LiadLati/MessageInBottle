import { useState } from 'react';
import type { OpenedLetterDto, ShoreBottleDto } from '@mib/shared';
import { api } from '../api/client.js';
import { ShoreScene } from '../components/lazy.js';
import { Avatar, ErrorNote, Skeleton } from '../components/ui.js';
import { Icon } from '../design/Icon.js';
import { formatDayTime, formatDuration } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';
import { useSession } from '../state/session.js';
import { OpenedLetterScreen } from './OpenedLetterScreen.js';

const POLL_MS = 15_000;

interface Props {
  onOpenProfile: () => void;
  onChooseShore: () => void;
}

// S2 · My Shore — real-time 3D coast. Only bottles the server has landed are ever shown.
export function MyShoreScreen({ onOpenProfile, onChooseShore }: Props) {
  const { user } = useSession();
  const shore = useAsync(() => api.myShore(), [], POLL_MS);
  const [opened, setOpened] = useState<{ letter: OpenedLetterDto; fresh: boolean } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const list = shore.data?.bottles ?? [];
  const sealed = list.filter((b) => b.state === 'delivered');
  const read = list.filter((b) => b.state === 'opened');
  const featured: ShoreBottleDto | undefined = sealed[0] ?? read[0];

  const open = async (b: ShoreBottleDto) => {
    setError(null);
    setBusy(true);
    try {
      const fresh = b.state === 'delivered';
      const letter = fresh ? await api.openBottle(b.id) : await api.readLetter(b.id);
      setOpened({ letter, fresh });
      await shore.reload();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  if (opened) {
    return (
      <OpenedLetterScreen
        letter={opened.letter}
        justOpened={opened.fresh}
        onBack={() => setOpened(null)}
      />
    );
  }

  if (!user?.shoreId) {
    return (
      <div className="world-screen">
        <div className="world-layer">
          <ShoreScene mode="shore" showBottle={false} />
        </div>
        <div className="scrim scrim-3d" />
        <header className="world-header on-3d">
          <div>
            <h1 className="t-title">My Shore</h1>
            <p className="t-meta">No anchor yet</p>
          </div>
        </header>
        <section className="sheet on-3d stack">
          <h2 className="t-display-sm">Choose a shore to anchor to</h2>
          <button type="button" className="btn-primary on-3d" onClick={onChooseShore}>
            Choose a shore
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="world-screen two-pane">
      <div className="world-layer">
        <ShoreScene mode="shore" showBottle={Boolean(featured)} />
      </div>
      <div className="scrim scrim-3d" />
      <header className="world-header on-3d">
        <div>
          <h1 className="t-title">My Shore</h1>
          <p className="t-meta">
            {shore.data?.shore?.name ?? '…'} · dusk
            {sealed.length > 0 ? ` · ${sealed.length} sealed` : ''}
          </p>
        </div>
        <button
          type="button"
          className="avatar glass"
          aria-label="Your account"
          onClick={onOpenProfile}
        >
          {user.displayName.charAt(0).toUpperCase()}
        </button>
      </header>
      <section className="sheet on-3d" aria-label="Arrivals">
        {shore.loading && !shore.data ? (
          <Skeleton />
        ) : !featured ? (
          <div className="stack">
            <h2 className="t-display-sm">The tide has brought nothing yet</h2>
            <p className="t-meta" style={{ fontSize: 12.5 }}>
              Bottles appear here only once they have truly landed. Nothing on the way is ever
              shown.
            </p>
          </div>
        ) : (
          <div>
            <div className="row">
              <Avatar name={featured.sender.displayName} size="md" />
              <div className="grow">
                <div className="t-card-title" style={{ color: 'var(--foam-white-3d)' }}>
                  {featured.state === 'delivered' ? 'A bottle from' : 'A letter from'}{' '}
                  {featured.sender.displayName}
                </div>
                <div className="t-meta" style={{ color: 'rgba(247,250,249,.7)' }}>
                  Landed {formatDayTime(featured.deliveredAt)} · sealed{' '}
                  {formatDuration(featured.journeyDurationMs)}
                </div>
              </div>
            </div>
            <button
              type="button"
              className="btn-primary on-3d"
              style={{ marginTop: 14 }}
              disabled={busy}
              onClick={() => void open(featured)}
            >
              <Icon name="bottle" size={18} />
              {featured.state === 'delivered' ? 'Pick it up' : 'Read it again'}
            </button>
            <p
              className="t-meta"
              style={{ textAlign: 'center', marginTop: 10, color: 'rgba(247,250,249,.62)' }}
            >
              {featured.state === 'delivered'
                ? 'Opening ends its journey'
                : 'Its journey is complete'}
            </p>
            {list.length > 1 ? (
              <ul className="list" style={{ marginTop: 14 }} aria-label="More on your shore">
                {list
                  .filter((b) => b.id !== featured.id)
                  .map((b) => (
                    <li key={b.id}>
                      <button
                        type="button"
                        className="row-item selectable"
                        disabled={busy}
                        onClick={() => void open(b)}
                      >
                        <Avatar name={b.sender.displayName} />
                        <span className="grow">
                          <span className="t-label" style={{ display: 'block' }}>
                            {b.state === 'delivered' ? 'Sealed bottle' : 'Opened letter'} from{' '}
                            {b.sender.displayName}
                          </span>
                          <span className="t-meta">Landed {formatDayTime(b.deliveredAt)}</span>
                        </span>
                        <span className="t-meta">{b.state === 'delivered' ? 'Open' : 'Read'}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            ) : null}
          </div>
        )}
        <ErrorNote error={error ?? shore.error} />
      </section>
    </div>
  );
}
