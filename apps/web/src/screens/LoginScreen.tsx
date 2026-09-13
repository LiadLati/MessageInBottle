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
    <main className="login-screen">
      <div
        className="world-layer"
        aria-hidden
        style={{
          backgroundImage: 'url(/textures/sky-dusk-equirect-1024x512.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center 40%',
          opacity: 0.9,
        }}
      />
      <div
        className="scrim"
        style={{ background: 'linear-gradient(rgba(6,18,27,.15), rgba(6,18,27,.92) 62%)' }}
      />
      <div className="login-card">
        <div className="brand">
          <img src="/brand/app-symbol.svg" alt="" />
          <span className="t-eyebrow">Slow correspondence</span>
        </div>
        <h1 className="t-display">Message in a Bottle</h1>
        <p className="secondary">
          Write to someone you know. Seal the letter, throw it into the sea, and follow its
          uncertain journey toward their shore.
        </p>
        <form onSubmit={submit} className="stack">
          <label className="field">
            <span className="t-label">Username</span>
            <input
              className="input"
              autoFocus
              autoCapitalize="none"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="ada, bo, cy — or a new name"
            />
          </label>
          <button className="btn-primary" disabled={busy || username.trim().length < 2}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <ErrorNote error={error} />
        </form>
        <p className="t-meta">
          Development sign-in: any username works. A shore is an app anchor, not a real location —
          no GPS is ever collected. Letters can strand or be lost.
        </p>
      </div>
    </main>
  );
}
