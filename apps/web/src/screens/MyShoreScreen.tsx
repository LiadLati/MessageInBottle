import { useState } from 'react';
import type { OpenedLetterDto } from '@mib/shared';
import { api } from '../api/client.js';
import { LetterPaper } from '../components/LetterPaper.js';
import { Empty, ErrorNote, Loading, Screen } from '../components/ui.js';
import { formatDate, formatDuration } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';
import { ShoreSetupScreen } from './ShoreSetupScreen.js';
import { useSession } from '../state/session.js';

const POLL_MS = 15_000;

export function MyShoreScreen() {
  const { user } = useSession();
  const [opened, setOpened] = useState<OpenedLetterDto | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [changing, setChanging] = useState(false);
  const shore = useAsync(() => api.myShore(), [], POLL_MS);

  if (!user?.shoreId || changing) return <ShoreSetupScreen onDone={() => setChanging(false)} />;

  const open = async (id: string, alreadyOpened: boolean) => {
    setError(null);
    try {
      setOpened(alreadyOpened ? await api.readLetter(id) : await api.openBottle(id));
      await shore.reload();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  if (opened) {
    return (
      <Screen
        title={`From ${opened.bottle.sender.displayName}`}
        actions={
          <button className="btn small" onClick={() => setOpened(null)}>
            Back
          </button>
        }
      >
        <p className="muted small">
          Released {formatDate(opened.bottle.releasedAt)} from {opened.bottle.originShore.name};
          travelled {formatDuration(opened.bottle.journeyDurationMs)}.
        </p>
        <LetterPaper text={opened.letter.text} font={opened.letter.font} aging={opened.aging} />
        <p className="muted small">
          The journey is complete. Fonts and aging change the look only, never the words.
        </p>
      </Screen>
    );
  }

  const list = shore.data?.bottles ?? [];
  return (
    <Screen
      title={`My Shore · ${shore.data?.shore?.name ?? ''}`}
      actions={
        <button className="btn small" onClick={() => setChanging(true)}>
          Change
        </button>
      }
    >
      <p className="muted small">
        Only bottles that have actually arrived appear here. Incoming journeys are never shown.
      </p>
      {shore.loading ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty>The tide has brought nothing yet.</Empty>
      ) : (
        <ul className="list" aria-label="Bottles on your shore">
          {list.map((b) => (
            <li key={b.id}>
              <button
                className="list-item as-button"
                onClick={() => void open(b.id, b.state === 'opened')}
              >
                <span>
                  <strong>{b.state === 'delivered' ? 'Sealed bottle' : 'Opened letter'}</strong>{' '}
                  from {b.sender.displayName}
                  <span className="muted small block">Arrived {formatDate(b.deliveredAt)}</span>
                </span>
                <span className="muted small">
                  {b.state === 'delivered' ? 'Open' : 'Read again'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={error ?? shore.error} />
    </Screen>
  );
}
