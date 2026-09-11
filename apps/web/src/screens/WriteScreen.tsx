import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_LETTER_FONT,
  FONT_DEFINITIONS,
  LETTER_FONTS,
  LETTER_MAX_CHARACTERS,
  countLetterCharacters,
  validateLetterText,
  type FriendDto,
  type LetterFont,
  type ReleasePreviewResponse,
  type SentBottleDto,
} from '@mib/shared';
import { api, ApiError } from '../api/client.js';
import { LetterPaper, ensureLetterFaces, letterTextStyle } from '../components/LetterPaper.js';
import { OceanMap, ReleaseSequence } from '../components/lazy.js';
import type { MapAnchor, MapRoute } from '../components/OceanMap.js';
import type { ReleaseStatus } from '../components/ReleaseSequence.js';
import { Avatar, BackButton, DeckScreen, ErrorNote, Skeleton } from '../components/ui.js';
import { Icon } from '../design/Icon.js';
import { formatDuration, newIdempotencyKey } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';
import { useSession } from '../state/session.js';

type Step = 'friend' | 'compose' | 'preview' | 'releasing';

interface Draft {
  recipient: FriendDto | null;
  text: string;
  font: LetterFont;
  idempotencyKey: string;
}

const DRAFT_KEY = 'mib.draft';

function loadDraft(): Draft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) return JSON.parse(raw) as Draft;
  } catch {
    /* ignore */
  }
  return {
    recipient: null,
    text: '',
    font: DEFAULT_LETTER_FONT,
    idempotencyKey: newIdempotencyKey(),
  };
}

interface Props {
  onReleased: (bottle: SentBottleDto) => void;
  onChooseShore: () => void;
}

export function WriteScreen({ onReleased, onChooseShore }: Props) {
  const { user } = useSession();
  const [step, setStep] = useState<Step>('friend');
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [preview, setPreview] = useState<ReleasePreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<Error | null>(null);
  const [releaseError, setReleaseError] = useState<Error | null>(null);
  const [releaseStatus, setReleaseStatus] = useState<ReleaseStatus>('releasing');
  const [released, setReleased] = useState<SentBottleDto | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const friends = useAsync(() => api.friends(), []);
  const chart = useAsync(() => api.chart(), []);

  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* ignore */
    }
  }, [draft]);
  useEffect(ensureLetterFaces, []);

  const validation = useMemo(() => validateLetterText(draft.text), [draft.text]);
  const characters = countLetterCharacters(draft.text);

  const choose = (friend: FriendDto) => {
    setDraft((d) => ({ ...d, recipient: friend }));
    setStep('compose');
  };

  const goPreview = async () => {
    if (!draft.recipient) return;
    setPreview(null);
    setPreviewError(null);
    setStep('preview');
    try {
      setPreview(await api.previewRelease(draft.recipient.id));
    } catch (err) {
      setPreviewError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // The request and the animation run independently: the map only appears on server commit and a
  // failure rewinds to the sealed letter with the draft byte-identical (storyboard §A).
  const release = () => {
    if (!draft.recipient || !validation.ok) return;
    setReleaseError(null);
    setReleaseStatus('releasing');
    setStep('releasing');
    api
      .release({
        recipientId: draft.recipient.id,
        text: draft.text,
        font: draft.font,
        idempotencyKey: draft.idempotencyKey,
      })
      .then((res) => {
        setReleased(res.bottle);
        setReleaseStatus('committed');
      })
      .catch((err: unknown) => {
        setReleaseError(err instanceof Error ? err : new Error(String(err)));
        setReleaseStatus('failed');
      });
  };

  const finish = useCallback(() => {
    if (!released) return;
    sessionStorage.removeItem(DRAFT_KEY);
    setDraft({
      recipient: null,
      text: '',
      font: DEFAULT_LETTER_FONT,
      idempotencyKey: newIdempotencyKey(),
    });
    setStep('friend');
    onReleased(released);
  }, [released, onReleased]);

  const rewind = useCallback(() => setStep('preview'), []);

  if (!user?.shoreId) {
    return (
      <DeckScreen title="Write">
        <div className="glass-panel stack">
          <h2 className="t-display-sm">Choose your shore first</h2>
          <p className="secondary">Bottles need a coast to be thrown from.</p>
          <button type="button" className="btn-primary" onClick={onChooseShore}>
            Choose a shore
          </button>
        </div>
      </DeckScreen>
    );
  }

  if (step === 'releasing') {
    return <ReleaseSequence status={releaseStatus} onFinished={finish} onFailed={rewind} />;
  }

  if (step === 'friend') {
    const d = friends.data;
    return (
      <DeckScreen
        title="Who is this for?"
        subtitle="They will not know a bottle is coming until it lands."
      >
        {friends.loading || !d ? (
          <Skeleton />
        ) : d.friends.length === 0 ? (
          <div className="glass-panel stack">
            <h2 className="t-display-sm">Only friends can receive your bottles</h2>
            <p className="secondary">Add someone by their exact username on the Friends tab.</p>
          </div>
        ) : (
          <ul className="list">
            {d.friends.map((f) => {
              const eligible = f.hasShore;
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    className={`row-item selectable${eligible ? '' : ' ineligible'}`}
                    disabled={!eligible}
                    onClick={() => choose(f)}
                  >
                    <Avatar name={f.displayName} />
                    <span className="grow">
                      <span className="t-card-title" style={{ display: 'block' }}>
                        {f.displayName}
                      </span>
                      <span className="t-meta">
                        @{f.username} · {eligible ? 'Room on their shore' : 'No shore chosen yet'}
                      </span>
                    </span>
                    {eligible ? <Icon name="back" size={16} className="flip" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <ErrorNote error={friends.error} />
      </DeckScreen>
    );
  }

  if (step === 'compose') {
    return (
      <DeckScreen
        title="A letter"
        subtitle={
          <>
            Addressed to{' '}
            <strong style={{ color: 'var(--foam-white)' }}>{draft.recipient?.displayName}</strong> ·
            shore hidden until arrival
          </>
        }
        actions={<BackButton onClick={() => setStep('friend')} label="Change" />}
      >
        <div className="parchment">
          <span className="grain" aria-hidden />
          <label className="sr-only" htmlFor="letter-text">
            Your letter
          </label>
          <textarea
            id="letter-text"
            className="compose-area"
            dir="auto"
            rows={9}
            value={draft.text}
            onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
            style={letterTextStyle(draft.font, false)}
            placeholder="Dear…"
            maxLength={8000}
          />
          <div className="letter-toolbar" style={{ marginTop: 14, marginBottom: 0 }}>
            <span>Words are never rewritten</span>
            <span
              className={`t-numeric counter${characters > LETTER_MAX_CHARACTERS ? ' over' : ''}`}
            >
              {characters} / {LETTER_MAX_CHARACTERS}
            </span>
          </div>
        </div>
        <fieldset className="font-chips" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">Visual font</legend>
          {LETTER_FONTS.map((f) => (
            <label key={f} className={`chip${draft.font === f ? ' selected' : ''}`}>
              <input
                type="radio"
                name="font"
                value={f}
                checked={draft.font === f}
                onChange={() => setDraft((d) => ({ ...d, font: f }))}
              />
              {FONT_DEFINITIONS[f].label}
            </label>
          ))}
        </fieldset>
        <p className="t-meta">
          Readable Print — same words, accessible face — is always available to the reader.
        </p>
        {!validation.ok && draft.text.length > 0 ? (
          <p className="note">
            {validation.reason === 'too_long'
              ? 'Too long: trim a little.'
              : validation.reason === 'too_many_bytes'
                ? 'Too large to store; shorten it.'
                : 'Write something first.'}
          </p>
        ) : null}
        <button type="button" className="btn-primary" disabled={!validation.ok} onClick={goPreview}>
          Seal the letter
        </button>
      </DeckScreen>
    );
  }

  // Preview & Release (IA S3) over the real route.
  const p = preview;
  const canRelease = p?.eligible === true && acknowledged;
  const routes: MapRoute[] =
    p?.route?.geoPoints && p.route.geoPoints.length > 1
      ? [
          {
            id: 'preview',
            points: p.route.geoPoints,
            progress: 0,
            progressAsOf: 0,
            plannedDurationMs: p.route.plannedDurationMs,
            live: false,
            state: 'at_sea',
          },
        ]
      : [];
  const anchors: MapAnchor[] = [];
  if (p?.originShore?.geo)
    anchors.push({
      id: p.originShore.id,
      name: p.originShore.name,
      geo: p.originShore.geo,
      role: 'origin',
    });
  if (p?.destinationShore?.geo)
    anchors.push({
      id: p.destinationShore.id,
      name: p.destinationShore.name,
      geo: p.destinationShore.geo,
      role: 'destination',
    });

  return (
    <div className="world-screen two-pane">
      <div className="world-layer">
        {chart.data ? (
          <OceanMap
            routes={routes}
            anchors={anchors}
            selectedRouteId="preview"
            fitKey={p ? 'preview' : ''}
            bottomPadding={420}
          />
        ) : null}
      </div>
      <div className="scrim scrim-map" />
      <div className="scrim-map-header" />
      <header className="world-header">
        <div>
          <h1 className="t-title">Preview &amp; release</h1>
          <p className="t-meta">
            {p?.route
              ? `A journey of about ${formatDuration(p.route.plannedDurationMs)}`
              : 'Charting the route…'}
          </p>
        </div>
        <BackButton onClick={() => setStep('compose')} label="Edit letter" />
      </header>
      <section className="sheet" aria-label="Preview and release">
        {!p && !previewError ? <Skeleton /> : null}
        {p ? (
          <dl className="passport-grid">
            <dt>From</dt>
            <dd>
              {user.displayName} · {p.originShore?.name ?? '—'}
            </dd>
            <dt>To</dt>
            <dd>
              {draft.recipient?.displayName} · {p.destinationShore?.name ?? '—'}
            </dd>
            <dt>Route</dt>
            <dd>
              {p.route
                ? `${Math.max(1, p.route.nodeIds.length - 1)} passages`
                : 'no connected route'}
            </dd>
          </dl>
        ) : null}
        {p && !p.eligible ? (
          <p className="note error" style={{ marginTop: 12 }}>
            {rejectionCopy(p.rejection)}
          </p>
        ) : null}
        <ErrorNote error={previewError} />
        <div style={{ marginTop: 14 }}>
          <LetterPaper text={draft.text} font={draft.font} />
        </div>
        <label className="checkbox-row" style={{ marginTop: 14 }}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            I understand this bottle may strand and become readable by strangers, be discarded, or
            be lost forever. It holds nothing sensitive or urgent.
          </span>
        </label>
        <button
          type="button"
          className="btn-primary"
          style={{ marginTop: 14 }}
          disabled={!canRelease}
          onClick={release}
        >
          <Icon name="bottle" size={18} />
          Seal and throw
        </button>
        <p className="t-meta" style={{ textAlign: 'center', marginTop: 8 }}>
          Nothing is released until the sea confirms it
        </p>
        {releaseError ? (
          <p className="note error" role="alert" style={{ marginTop: 12 }}>
            {releaseError instanceof ApiError && releaseError.code === 'release_rejected'
              ? releaseError.message
              : `The sea did not take it: ${releaseError.message}.`}{' '}
            Your letter is intact.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function rejectionCopy(rejection: ReleasePreviewResponse['rejection']): string {
  switch (rejection) {
    case 'sender_has_no_shore':
      return 'Choose your shore before releasing a bottle.';
    case 'recipient_has_no_shore':
      return 'Your friend has not chosen a shore yet.';
    case 'shore_full':
      return 'Shore full — your draft will be kept. Try again later.';
    case 'route_unavailable':
      return 'No connected sea route reaches that shore.';
    case 'not_friends':
      return 'You can only send bottles to approved friends.';
    case 'self_send':
      return 'A bottle cannot be addressed to yourself.';
    default:
      return 'Delivery to this friend is unavailable right now.';
  }
}
