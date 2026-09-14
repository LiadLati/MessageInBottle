import { useMemo, useState } from 'react';
import type { ShoreDto } from '@mib/shared';
import { api } from '../api/client.js';
import { OceanMap } from '../components/lazy.js';
import type { MapAnchor } from '../components/OceanMap.js';
import { ErrorNote, Skeleton } from '../components/ui.js';
import { Icon } from '../design/Icon.js';
import { useAsync } from '../lib/useAsync.js';
import { useSession } from '../state/session.js';

interface Props {
  onDone?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Name, country and sea all count, accent-insensitively ("Malaga" finds Málaga).
function matches(shore: ShoreDto, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  return [shore.name, shore.country ?? '', shore.sea ?? ''].some((v) => fold(v).includes(q));
}

// "Portugal · North Atlantic · 5 places"; the original fictional shores have no country.
function describe(shore: ShoreDto): string {
  const parts = [shore.country, shore.sea].filter((p): p is string => Boolean(p));
  if (parts.length === 0) parts.push('App anchor');
  return `${parts.join(' · ')} · ${shore.capacity} places`;
}

// Shore selection over the real map (IA S9c). Manual only: no GPS, no coordinates collected.
// On phones the map is the whole screen: pins (clustered when dense) are the list, a search
// field finds a harbour by name, country or sea; picking one raises a compact card with the
// shore's details and "Anchor here". Desktop keeps a searchable side pane.
export function ShoreSetupScreen({ onDone, onCancel }: Props) {
  const { user, refresh } = useSession();
  const chart = useAsync(() => api.chart(), []);
  const [choice, setChoice] = useState<string | null>(user?.shoreId ?? null);
  const [focus, setFocus] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const shores = useMemo(
    () => [...(chart.data?.shores ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [chart.data],
  );
  const anchors: MapAnchor[] = useMemo(
    () =>
      shores
        .filter((s) => s.geo)
        .map((s) => ({ id: s.id, name: s.name, geo: s.geo!, role: 'shore' as const })),
    [shores],
  );
  const filtered = useMemo(() => shores.filter((s) => matches(s, query)), [shores, query]);
  const chosen = shores.find((s) => s.id === choice) ?? null;
  const searching = query.trim().length > 0;

  const pick = (id: string) => {
    setChoice(id);
    setFocus(id);
    setQuery('');
  };

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

  const changing = Boolean(user?.shoreId);
  const anchorButton = (
    <button
      type="button"
      className="btn-primary"
      disabled={!choice || busy || choice === user?.shoreId}
      onClick={save}
    >
      {busy ? 'Anchoring…' : choice === user?.shoreId ? 'Anchored here' : 'Anchor here'}
    </button>
  );
  const searchField = (id: string) => (
    <div className="shore-search-field">
      <Icon name="search" size={16} />
      <input
        id={id}
        className="input"
        type="search"
        autoComplete="off"
        placeholder="Search a harbour, country or sea"
        aria-label="Search shores"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {searching ? (
        <button
          type="button"
          className="clear"
          aria-label="Clear search"
          onClick={() => setQuery('')}
        >
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </div>
  );
  const shoreRow = (s: ShoreDto) => {
    const selected = choice === s.id;
    return (
      <li key={s.id}>
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          className={`row-item selectable${selected ? ' selected' : ''}`}
          onClick={() => pick(s.id)}
        >
          <span className="grow">
            <span className="t-card-title" style={{ display: 'block' }}>
              {s.name}
            </span>
            <span className="t-meta">{describe(s)}</span>
          </span>
          {selected ? (
            <span className="check-circle" aria-hidden>
              <Icon name="check" size={14} />
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  return (
    <div className="world-screen two-pane shore-setup">
      <div className="world-layer">
        <OceanMap
          routes={[]}
          anchors={anchors}
          showAnchorLabels
          selectedAnchorId={choice}
          focusAnchorId={focus}
          onSelectAnchor={(id) => setChoice((c) => (c === id ? null : id))}
          bottomPadding={200}
          fitKey="shores"
        />
      </div>
      <div className="scrim scrim-map" />
      <div className="scrim-map-header" />
      <header className="world-header">
        <div>
          <h1 className="t-title">{changing ? 'Change your shore' : 'Choose your shore'}</h1>
          <p className="t-meta">Tap a coast or search · nothing about you is located</p>
        </div>
        {onCancel ? (
          <button type="button" className="glass-control" aria-label="Cancel" onClick={onCancel}>
            <Icon name="close" size={18} />
          </button>
        ) : null}
      </header>

      {/* Phone: search floats under the header; results replace the map pins as the list. */}
      <div className="shore-search phone-only">
        {searchField('shore-search-phone')}
        {searching ? (
          <ul className="list shore-results" role="radiogroup" aria-label="Matching shores">
            {filtered.slice(0, 8).map(shoreRow)}
            {filtered.length === 0 ? <li className="t-meta empty">No shore matches.</li> : null}
            {filtered.length > 8 ? (
              <li className="t-meta empty">{filtered.length - 8} more · keep typing</li>
            ) : null}
          </ul>
        ) : null}
      </div>

      {/* Phone: a compact card only once a pin is chosen; closing it restores the clean map. */}
      {chosen && !searching ? (
        <section className="sheet shore-card phone-only" aria-label="Selected shore">
          <div className="row">
            <div className="grow">
              <h2 className="t-card-title">{chosen.name}</h2>
              <p className="t-meta">{describe(chosen)}</p>
            </div>
            <button
              type="button"
              className="glass-control"
              aria-label="Deselect shore"
              onClick={() => setChoice(null)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <div style={{ marginTop: 12 }}>{anchorButton}</div>
          <p className="t-meta" style={{ marginTop: 8 }}>
            A shore is only an anchor in the app. Changing it affects future bottles only.
          </p>
          <ErrorNote error={error} />
        </section>
      ) : null}
      {chart.error ? (
        <section className="sheet phone-only">
          <ErrorNote error={chart.error} />
        </section>
      ) : null}

      {/* Desktop: the side pane lists every shore next to the map, filtered by the search. */}
      <section className="sheet desktop-only" aria-label="Shores">
        {chart.loading || !chart.data ? (
          <Skeleton />
        ) : (
          <div className="stack">
            {searchField('shore-search-desktop')}
            <p className="t-meta">
              {searching
                ? `${filtered.length} of ${shores.length} shores`
                : `${shores.length} shores across every coast`}
            </p>
            <ul className="list shore-list" role="radiogroup" aria-label="Available shores">
              {filtered.map(shoreRow)}
              {filtered.length === 0 ? <li className="t-meta empty">No shore matches.</li> : null}
            </ul>
            {anchorButton}
            <p className="t-meta">
              A shore is only an anchor in the app. It says nothing about where you live, and
              changing it affects future bottles only.
            </p>
            <ErrorNote error={error ?? chart.error} />
          </div>
        )}
      </section>
    </div>
  );
}
