import { Component, type ErrorInfo, type ReactNode } from 'react';

// Without a boundary React unmounts the whole root on any render error — including the
// "Failed to fetch dynamically imported module" a lazy chunk throws after a deploy replaced
// the hashed files — and the person is left with a blank page (audit FE-001).
interface Props {
  children: ReactNode;
  // What to show instead of the children once something below has failed.
  fallback: (reset: () => void) => ReactNode;
}
interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No error reporting service exists; the console is where a developer will look.
    console.error('SeaYou view failed', error, info.componentStack);
  }

  private readonly reset = () => this.setState({ failed: false });

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.reset) : this.props.children;
  }
}

const reload = () => window.location.reload();

// The whole app: something went wrong that nothing below handled.
export function AppCrashed() {
  return (
    <main className="deck-screen" role="alert">
      <div
        className="glass-panel stack"
        style={{ maxWidth: 480, margin: '15vh auto', padding: 24 }}
      >
        <h1 className="t-display">Something went wrong</h1>
        <p className="secondary">
          SeaYou hit a problem it could not recover from on this page. Your letters and account are
          safe on the server. Reloading usually fixes it.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn-primary" onClick={reload}>
            Reload SeaYou
          </button>
          <a className="btn-secondary" href="/support">
            Help &amp; Support
          </a>
        </div>
      </div>
    </main>
  );
}

// One lazily loaded part (the map, the shore scene, the release sequence, the sea viewer):
// the rest of the app keeps working, and the person is offered a way to recover.
export function PartUnavailable({ what, retry }: { what: string; retry: () => void }) {
  return (
    <div className="glass-panel stack" role="alert" style={{ margin: 16, padding: 16 }}>
      <p>
        The {what} could not be loaded. This usually means SeaYou was updated while this page was
        open, or the connection dropped.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn-primary" onClick={reload}>
          Reload SeaYou
        </button>
        <button type="button" className="btn-secondary" onClick={retry}>
          Try again
        </button>
      </div>
    </div>
  );
}
