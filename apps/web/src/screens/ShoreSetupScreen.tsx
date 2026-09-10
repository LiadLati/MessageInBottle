import { useState } from 'react';
import { api } from '../api/client.js';
import { SeaChart } from '../components/SeaChart.js';
import { ErrorNote, Loading, Screen } from '../components/ui.js';
import { useAsync } from '../lib/useAsync.js';
import { useSession } from '../state/session.js';

export function ShoreSetupScreen({ onDone }: { onDone?: () => void }) {
  const { user, refresh } = useSession();
  const chart = useAsync(() => api.chart(), []);
  const [choice, setChoice] = useState<string | null>(user?.shoreId ?? null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await api.setMyShore(choice);
      await refresh();
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={user?.shoreId ? 'My Shore' : 'Choose your shore'}>
      <p className="muted">
        Your shore is where bottles addressed to you wash up. It is a virtual anchor on a fictional
        sea: it says nothing about where you live. GPS-assisted suggestions are not part of this
        build; pick one manually.
      </p>
      {chart.loading || !chart.data ? (
        <Loading />
      ) : (
        <>
          <SeaChart chart={chart.data} bottles={[]} destinationShoreId={choice} />
          <div className="shore-list" role="radiogroup" aria-label="Shores">
            {chart.data.shores.map((s) => (
              <label key={s.id} className={`shore-option${choice === s.id ? ' selected' : ''}`}>
                <input
                  type="radio"
                  name="shore"
                  value={s.id}
                  checked={choice === s.id}
                  onChange={() => setChoice(s.id)}
                />
                <span>{s.name}</span>
                <span className="muted small">{s.capacity} bottle slots</span>
              </label>
            ))}
          </div>
          <button
            className="btn primary"
            disabled={!choice || busy || choice === user?.shoreId}
            onClick={save}
          >
            {busy ? 'Saving…' : user?.shoreId ? 'Change shore' : 'Confirm shore'}
          </button>
          <ErrorNote error={error ?? chart.error} />
        </>
      )}
    </Screen>
  );
}
