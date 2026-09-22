import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  PUBLISHED_DOCUMENTS,
  confirmationProblem,
  currentPolicyVersions,
  emailProblem,
  passwordProblem,
  usernameProblem,
  type DocumentId,
} from '@mib/shared';
import { ApiError, UNREACHABLE, api, type HealthResponse } from '../api/client.js';
import { EMPTY_CONSENT, PolicyConsent, consentProblems } from '../components/PolicyConsent.js';
import { SupportLink } from '../components/SupportLink.js';
import { Icon } from '../design/Icon.js';
import { useSession } from '../state/session.js';

type Mode = 'signin' | 'register' | 'forgot' | 'reset';

interface Props {
  // Present when the app was opened from a password-reset link.
  resetToken?: string | undefined;
  onResetDone?: (() => void) | undefined;
  // Opens one of the three documents over this screen (the shell owns the dialog).
  onOpenPolicy: (doc: DocumentId) => void;
}

// Turns an API failure into one sentence for the person; sign-in failures stay generic on
// purpose (the server never says whether the username or address exists).
function describeFailure(err: unknown, mode: Mode): string {
  if (err instanceof ApiError) {
    if (err.code === UNREACHABLE) return err.message;
    if (err.status === 401) return 'Incorrect username or password.';
    if (err.code === 'username_taken') return 'That username is already taken. Choose another.';
    if (err.code === 'email_taken') return 'That email is already registered. Sign in instead.';
    if (err.code === 'policy_version_stale')
      return 'The Terms or Privacy Policy changed while this page was open. Reload and read them again.';
    if (err.code === 'policies_not_released')
      return 'Registration is closed until the Terms of Use and Privacy Policy are published.';
    if (err.code === 'reset_invalid')
      return 'This reset link is invalid or has expired. Request a new one.';
    if (err.status === 429) {
      const s = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      const mins = s ? Math.max(1, Math.ceil(s / 60)) : null;
      return mins
        ? `Too many attempts. Try again in about ${mins} ${mins === 1 ? 'minute' : 'minutes'}.`
        : 'Too many attempts. Try again in a few minutes.';
    }
    if (err.status === 400) return 'Please check the fields and try again.';
    if (err.status >= 500) return 'Something went wrong on the server. Try again in a moment.';
    return err.message;
  }
  const what =
    mode === 'register'
      ? 'create the account'
      : mode === 'forgot'
        ? 'send the reset link'
        : mode === 'reset'
          ? 'change the password'
          : 'sign in';
  return `Could not ${what}. Check your connection and try again.`;
}

function PasswordInput({
  id,
  value,
  onChange,
  onBlur,
  problem,
  autoComplete,
  placeholder,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  problem: string | null;
  autoComplete: 'new-password' | 'current-password';
  placeholder: string;
  disabled: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <>
      <div className="password-field">
        <input
          id={id}
          className={`input${problem ? ' invalid' : ''}`}
          type={show ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          disabled={disabled}
          aria-invalid={Boolean(problem)}
          aria-describedby={problem ? `${id}-err` : undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
        />
        <button
          type="button"
          className="btn-ghost reveal"
          aria-pressed={show}
          aria-controls={id}
          aria-label={show ? 'Hide password' : 'Show password'}
          onClick={() => setShow((v) => !v)}
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
      {problem ? (
        <p id={`${id}-err`} className="field-error" role="alert">
          {problem}
        </p>
      ) : null}
    </>
  );
}

// Development builds do not deliver mail: the outbox captures it in memory instead. Saying so
// on the recovery screen — and offering the captured messages — is the difference between a
// flow that looks broken and one that is simply not wired to a mail provider yet. It states
// nothing about the address that was just submitted, so it cannot reveal whether it is known.
function DevMailNotice({ health }: { health: HealthResponse }) {
  const [messages, setMessages] = useState<Array<{ id: number; to: string; text: string }> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const provider = health.mail?.provider ?? 'disabled';

  const load = async () => {
    setBusy(true);
    try {
      setMessages((await api.devOutbox()).messages);
    } catch {
      setMessages([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="note amber dev-mail" role="status">
      <strong>Development mode: no email is sent.</strong>{' '}
      {provider === 'outbox'
        ? 'Messages are captured inside the app. Open the development outbox to find the reset link.'
        : 'Mail is switched off entirely. Configure an SMTP provider to deliver messages.'}
      {provider === 'outbox' ? (
        <>
          <button type="button" className="btn-text" disabled={busy} onClick={() => void load()}>
            {busy
              ? 'Opening…'
              : messages
                ? 'Refresh development outbox'
                : 'Open development outbox'}
          </button>
          {messages ? (
            messages.length === 0 ? (
              <span className="t-meta">Nothing captured yet.</span>
            ) : (
              <ul className="list dev-mail-list">
                {[...messages].reverse().map((m) => {
                  const link = /https?:\/\/\S+/.exec(m.text)?.[0];
                  return (
                    <li key={m.id}>
                      <span className="t-meta">{m.to}</span>
                      {link ? (
                        <a className="btn-secondary" href={link}>
                          Open reset link
                        </a>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function LoginScreen({ resetToken, onResetDone, onOpenPolicy }: Props) {
  const { login, register } = useSession();
  const [mode, setMode] = useState<Mode>(resetToken ? 'reset' : 'signin');
  const [consent, setConsent] = useState(EMPTY_CONSENT);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState<
    Partial<Record<'username' | 'email' | 'password' | 'confirm', true>>
  >({});
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const ids = { u: useId(), e: useId(), p: useId(), c: useId() };

  // Only the recovery screens need to know how mail is handled.
  const wantsMailInfo = mode === 'forgot' || mode === 'reset';
  useEffect(() => {
    if (!wantsMailInfo || health) return;
    let cancelled = false;
    void api
      .health()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wantsMailInfo, health]);

  const registering = mode === 'register';
  const resetting = mode === 'reset';
  const forgot = mode === 'forgot';
  const needsPassword = mode === 'signin' || registering || resetting;
  const needsConfirm = registering || resetting;
  const problems = {
    username: mode === 'signin' || registering ? usernameProblem(username) : null,
    email: registering || forgot ? emailProblem(email) : null,
    password: needsPassword
      ? registering || resetting
        ? passwordProblem(password, registering ? username : '')
        : password
          ? null
          : 'Enter your password.'
      : null,
    confirm: needsConfirm ? confirmationProblem(password, confirm) : null,
  };
  const show = (field: keyof typeof problems) =>
    (touched[field] || submitted) && problems[field] ? problems[field] : null;
  const consentOk =
    !registering || (!consentProblems(consent).terms && !consentProblems(consent).privacy);
  const formValid =
    !problems.username && !problems.email && !problems.password && !problems.confirm && consentOk;
  const touch = (field: keyof typeof problems) => () =>
    setTouched((t) => ({ ...t, [field]: true }));

  const switchMode = (next: Mode) => {
    setMode(next);
    setFailure(null);
    setSuccess(null);
    setSubmitted(false);
    setTouched({});
    setPassword('');
    setConfirm('');
    setConsent(EMPTY_CONSENT);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setFailure(null);
    if (!formValid) return;
    setBusy(true);
    try {
      if (registering)
        await register(username.trim(), email.trim(), password, {
          acceptTerms: true,
          acceptGuidelines: true,
          acknowledgePrivacy: true,
          versions: currentPolicyVersions(),
        });
      else if (forgot) {
        await api.forgotPassword(email.trim());
        setSuccess(
          'If an account exists for that address, a reset link is on its way. It works for 30 minutes.',
        );
        setBusy(false);
      } else if (resetting) {
        await api.resetPassword(resetToken ?? '', password);
        onResetDone?.();
        switchMode('signin');
        setSuccess('Your password was changed. Sign in with the new one.');
        setBusy(false);
      } else await login(username.trim(), password);
    } catch (err) {
      setFailure(describeFailure(err, mode));
      setBusy(false);
    }
  };

  const title =
    mode === 'register'
      ? 'Create your account'
      : mode === 'forgot'
        ? 'Forgot your password?'
        : mode === 'reset'
          ? 'Choose a new password'
          : 'SeaYou';
  const intro =
    mode === 'register'
      ? 'A username your friends will recognise, an email for recovery, and a password only you know.'
      : mode === 'forgot'
        ? 'Enter the email address on your account and we will send a link to choose a new password.'
        : mode === 'reset'
          ? 'The new password replaces the old one everywhere: every signed-in device will need it.'
          : 'Write to someone you know. Seal the letter, throw it into the sea, and follow its uncertain journey toward their shore.';

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
        <h1 className="t-display">{title}</h1>
        <p className="secondary">{intro}</p>
        <form onSubmit={submit} className="stack" noValidate aria-busy={busy}>
          {mode === 'signin' || registering ? (
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
                value={username}
                disabled={busy}
                aria-invalid={Boolean(show('username'))}
                aria-describedby={show('username') ? `${ids.u}-err` : undefined}
                onChange={(e) => setUsername(e.target.value)}
                onBlur={touch('username')}
                placeholder={registering ? 'letters, digits, underscore' : 'your username'}
              />
              {show('username') ? (
                <p id={`${ids.u}-err`} className="field-error" role="alert">
                  {show('username')}
                </p>
              ) : null}
            </div>
          ) : null}
          {registering || forgot ? (
            <div className="field">
              <label className="t-label" htmlFor={ids.e}>
                Email
              </label>
              <input
                id={ids.e}
                className={`input${show('email') ? ' invalid' : ''}`}
                type="email"
                autoFocus={forgot}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="email"
                inputMode="email"
                value={email}
                disabled={busy}
                aria-invalid={Boolean(show('email'))}
                aria-describedby={show('email') ? `${ids.e}-err` : undefined}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={touch('email')}
                placeholder="you@example.com"
              />
              {show('email') ? (
                <p id={`${ids.e}-err`} className="field-error" role="alert">
                  {show('email')}
                </p>
              ) : null}
            </div>
          ) : null}
          {needsPassword ? (
            <div className="field">
              <label className="t-label" htmlFor={ids.p}>
                {resetting ? 'New password' : 'Password'}
              </label>
              <PasswordInput
                id={ids.p}
                value={password}
                onChange={setPassword}
                onBlur={touch('password')}
                problem={show('password')}
                autoComplete={registering || resetting ? 'new-password' : 'current-password'}
                placeholder={registering || resetting ? 'at least 8 characters' : '••••••••'}
                disabled={busy}
              />
            </div>
          ) : null}
          {mode === 'signin' ? (
            <button
              type="button"
              className="btn-text forgot-link"
              disabled={busy}
              onClick={() => switchMode('forgot')}
            >
              Forgot password?
            </button>
          ) : null}
          {needsConfirm ? (
            <div className="field">
              <label className="t-label" htmlFor={ids.c}>
                Confirm {resetting ? 'new ' : ''}password
              </label>
              <PasswordInput
                id={ids.c}
                value={confirm}
                onChange={setConfirm}
                onBlur={touch('confirm')}
                problem={show('confirm')}
                autoComplete="new-password"
                placeholder="the same password again"
                disabled={busy}
              />
            </div>
          ) : null}
          {registering ? (
            <PolicyConsent
              value={consent}
              onChange={setConsent}
              onOpen={onOpenPolicy}
              showProblems={submitted}
              disabled={busy}
            />
          ) : null}
          {failure ? (
            <p className="note error" role="alert">
              {failure}
            </p>
          ) : null}
          {success ? (
            <p className="note success" role="status">
              {success}
            </p>
          ) : null}
          {forgot && health?.devMode && health.mail?.delivers === false ? (
            <DevMailNotice health={health} />
          ) : null}
          {forgot && success ? null : (
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? (
                <>
                  <span className="pulse-dot" aria-hidden />
                  {registering
                    ? 'Creating your account…'
                    : forgot
                      ? 'Sending…'
                      : resetting
                        ? 'Changing the password…'
                        : 'Signing in…'}
                </>
              ) : registering ? (
                'Create account'
              ) : forgot ? (
                'Send reset link'
              ) : resetting ? (
                'Set new password'
              ) : (
                'Sign in'
              )}
            </button>
          )}
          {mode === 'signin' ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => switchMode('register')}
            >
              Create account
            </button>
          ) : (
            <button
              type="button"
              className="btn-text auth-switch"
              disabled={busy}
              onClick={() => {
                if (resetting) onResetDone?.();
                switchMode('signin');
              }}
            >
              <Icon name="back" size={14} />
              Back to sign in
            </button>
          )}
        </form>
        <p className="t-meta">
          A shore is an app anchor, not a real location — no GPS is ever collected. Letters can
          strand or be lost.
        </p>
        <nav className="policy-links" aria-label="Terms, privacy and support">
          <SupportLink />
          {PUBLISHED_DOCUMENTS.map((d) => (
            <button
              key={d.id}
              type="button"
              className="btn-text"
              disabled={busy}
              onClick={() => onOpenPolicy(d.id)}
            >
              {d.title}
            </button>
          ))}
        </nav>
      </div>
    </main>
  );
}
