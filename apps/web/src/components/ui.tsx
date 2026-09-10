import type { ReactNode } from 'react';
import { ApiError } from '../api/client.js';

export function Screen({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="screen">
      <header className="screen-header">
        <h1>{title}</h1>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function ErrorNote({ error }: { error: Error | null }) {
  if (!error) return null;
  const message =
    error instanceof ApiError ? error.message : `Something went wrong: ${error.message}`;
  return (
    <p className="note note-error" role="alert">
      {message}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted empty">{children}</p>;
}

export function Loading() {
  return <p className="muted">Loading…</p>;
}

export function StatusPill({ state }: { state: string }) {
  const labels: Record<string, string> = {
    at_sea: 'At sea',
    delivered: 'Arrived',
    opened: 'Opened',
    stranded_public: 'Stranded',
    public_expired: 'Expired',
    lost: 'Lost',
    discarded: 'Discarded',
    cancelled: 'Delivery unavailable',
  };
  return <span className={`pill pill-${state}`}>{labels[state] ?? state}</span>;
}
