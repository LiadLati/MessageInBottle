import { useState, type FormEvent } from 'react';
import { useSession } from '../state/session.js';
import { ErrorNote } from '../components/ui.js';

export function LoginScreen() {
  const { login } = useSession();
  const [username, setUsername] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim());
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="app-shell login">
      <h1>Message in a Bottle</h1>
      <p className="lede">
        Write to someone you know. Seal it, throw it into the sea, and follow its uncertain journey
        to their shore.
      </p>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>Username (development sign-in)</span>
          <input
            autoFocus
            autoCapitalize="none"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="ada, bo, cy, dee or a new name"
          />
        </label>
        <button className="btn primary" disabled={busy || username.trim().length < 2}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <ErrorNote error={error} />
      </form>
      <p className="muted small">
        A shore is an app anchor, not a real location. No GPS is collected. Letters may be lost at
        sea.
      </p>
    </main>
  );
}
