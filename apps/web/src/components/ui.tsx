import type { ReactNode } from 'react';
import { ApiError } from '../api/client.js';
import { initials } from '../lib/format.js';
import { Icon } from '../design/Icon.js';

export function ErrorNote({ error }: { error: Error | null }) {
  if (!error) return null;
  const message =
    error instanceof ApiError ? error.message : `Something went wrong: ${error.message}`;
  return (
    <p className="note error" role="alert">
      {message}
    </p>
  );
}

export function Skeleton() {
  return (
    <div className="skeleton" aria-label="Loading" role="status">
      <span />
      <span />
      <span />
    </div>
  );
}

export function Avatar({
  name,
  size,
  tone = 'sea',
  className = '',
}: {
  name: string;
  size?: 'md';
  tone?: 'sea' | 'foam' | 'glass';
  className?: string;
}) {
  return (
    <span className={`avatar ${size ?? ''} ${tone === 'sea' ? '' : tone} ${className}`} aria-hidden>
      {initials(name)}
    </span>
  );
}

const STATUS_LABELS: Record<string, { label: string; glyph: string }> = {
  at_sea: { label: 'At sea', glyph: '◦' },
  delivered: { label: 'Arrived', glyph: '✓' },
  opened: { label: 'Opened', glyph: '✓' },
  stranded_public: { label: 'Stranded', glyph: '◈' },
  public_expired: { label: 'Expired', glyph: '◈' },
  lost: { label: 'Lost', glyph: '✕' },
  discarded: { label: 'Discarded', glyph: '✕' },
  cancelled: { label: 'Unavailable', glyph: '✕' },
};

// Status = colour + glyph + word (design a11y rule).
export function StatusChip({ state }: { state: string }) {
  const s = STATUS_LABELS[state] ?? { label: state, glyph: '' };
  return (
    <span className={`status-chip status-${state}`}>
      <span aria-hidden>{s.glyph}</span>
      {s.label}
    </span>
  );
}

export function DeckScreen({
  title,
  subtitle,
  actions,
  children,
  wide = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className="deck-screen">
      <div className="deck-column" style={wide ? { maxWidth: 760 } : undefined}>
        <header className="deck-header">
          <div>
            <h1 className="t-title">{title}</h1>
            {subtitle ? <p className="t-meta">{subtitle}</p> : null}
          </div>
          {actions}
        </header>
        {children}
      </div>
    </section>
  );
}

export function BackButton({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="btn-ghost" onClick={onClick}>
      <Icon name="back" size={16} />
      {label}
    </button>
  );
}

export function PlacesFree({ capacity, used }: { capacity: number; used: number }) {
  const free = Math.max(0, capacity - used);
  return (
    <span>
      {free} {free === 1 ? 'place' : 'places'} free
    </span>
  );
}
