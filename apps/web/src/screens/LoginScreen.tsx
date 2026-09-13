import { useId, useState, type FormEvent } from 'react';
import { confirmationProblem, passwordProblem, usernameProblem } from '@mib/shared';
import { ApiError } from '../api/client.js';
import { Icon } from '../design/Icon.js';
import { useSession } from '../state/session.js';

type Mode = 'signin' | 'register';

// Turns an API failure into one sentence for the person; sign-in failures stay generic on
// purpose (the server never says whether the username exists).
function describeFailure(err: unknown, mode: Mode): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Incorrect username or password.';
    if (err.code === 'username_taken') return 'That username is already taken. Choose another.';
    if (err.status === 429) {
      const s = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      const mins = s ? Math.max(1, Math.ceil(s / 60)) : null;
      return mins
        ? `Too many attempts. Try again in about ${mins} ${mins === 1 ? 'minute' : 'minutes'}.`
        : 'Too many attempts. Try again in a few minutes.';
    }
    if (err.status === 400) return 'Please check the fields and try again.';
    if (err.status >= 500) return 'The sea is unreachable right now. Try again in a moment.';
    return err.message;
  }
  return mode === 'register'
    ? 'Could not create the account. Check your connection and try again.'
    : 'Could not sign in. Check your connection and try again.';
}

export function LoginScreen() {
  const { login, register } = useSession();
  const [mode, setMode] = useState<Mode>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState<{ username?: true; password?: true; confirm?: true }>({});
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { u: useId(), p: useId(), c: useId(), err: useId() };

  const registering = mode === 'register';
  const problems = {
    username: usernameProblem(username),
    password: registering
      ? passwordProblem(password, username)
      : password
        ? null
        : 'Enter your password.',
    confirm: registering ? confirmationProblem(password, confirm) : null,
  };
  const show = (field: keyof typeof problems) =>
    (touched[field] || submitted) && problems[field] ? problems[field] : null;
  const formValid = !problems.username && !problems.password && !problems.confirm;

  const switchMode = (next: Mode) => {
    setMode(next);
    setFailure(null);
    setSubmitted(false);
    setTouched({});
    setConfirm('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setFailure(null);
    if (!formValid) return;
    setBusy(true);
    try {
      if (registering) await register(username.trim(), password);
      else await login(username.trim(), password);
    } catch (err) {
      setFailure(describeFailure(err, mode));
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
        <h1 className="t-display">{registering ? 'Create your account' : 'Message in a Bottle'}</h1>
        <p className="secondary">
          {registering
            ? 'A username your friends will recognise, and a password only you know.'
            : 'Write to someone you know. Seal the letter, throw it into the sea, and follow its uncertain journey toward their shore.'}
        </p>
        <form onSubmit={submit} className="stack" noValidate aria-busy={busy}>
          <div className="field">
            <label className="t-label" htmlFor={ids.u}>
              Username
            </label>
            <input
              id={ids.u}
              className={`input${show('username') ? ' invalid' : ''}`}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="username"
              inputMode="text"
              value={username}
              disabled={busy}
              aria-invalid={Boolean(show('username'))}
              aria-describedby={show('username') ? `${ids.u}-err` : undefined}
              onChange={(e) => setUsername(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, username: true }))}
              placeholder={registering ? 'letters, digits, underscore' : 'your username'}
            />
            {show('username') ? (
              <p id={`${ids.u}-err`} className="field-error" role="alert">
                {show('username')}
              </p>
            ) : null}
          </div>
          <div className="field">
            <label className="t-label" htmlFor={ids.p}>
              Password
            </label>
            <div className="password-field">
              <input
                id={ids.p}
                className={`input${show('password') ? ' invalid' : ''}`}
                type={showPassword ? 'text' : 'password'}
                autoComplete={registering ? 'new-password' : 'current-password'}
                value={password}
                disabled={busy}
                aria-invalid={Boolean(show('password'))}
                aria-describedby={show('password') ? `${ids.p}-err` : undefined}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                placeholder={registering ? 'at least 8 characters' : '••••••••'}
              />
              <button
                type="button"
                className="btn-ghost reveal"
                aria-pressed={showPassword}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            {show('password') ? (
              <p id={`${ids.p}-err`} className="field-error" role="alert">
                {show('password')}
              </p>
            ) : null}
          </div>
          {registering ? (
            <div className="field">
              <label className="t-label" htmlFor={ids.c}>
                Confirm password
              </label>
              <input
                id={ids.c}
                className={`input${show('confirm') ? ' invalid' : ''}`}
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirm}
                disabled={busy}
                aria-invalid={Boolean(show('confirm'))}
                aria-describedby={show('confirm') ? `${ids.c}-err` : undefined}
                onChange={(e) => setConfirm(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, confirm: true }))}
                placeholder="the same password again"
              />
              {show('confirm') ? (
                <p id={`${ids.c}-err`} className="field-error" role="alert">
                  {show('confirm')}
                </p>
              ) : null}
            </div>
          ) : null}
          {failure ? (
            <p id={ids.err} className="note error" role="alert">
              {failure}
            </p>
          ) : null}
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? (
              <>
                <span className="pulse-dot" aria-hidden />
                {registering ? 'Creating your account…' : 'Signing in…'}
              </>
            ) : registering ? (
              'Create account'
            ) : (
              'Sign in'
            )}
          </button>
          {registering ? (
            <button
              type="button"
              className="btn-text auth-switch"
              disabled={busy}
              onClick={() => switchMode('signin')}
            >
              <Icon name="back" size={14} />
              Back to sign in
            </button>
          ) : (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => switchMode('register')}
            >
              Create account
            </button>
          )}
        </form>
        <p className="t-meta">
          A shore is an app anchor, not a real location — no GPS is ever collected. Letters can
          strand or be lost.
        </p>
      </div>
    </main>
  );
}
