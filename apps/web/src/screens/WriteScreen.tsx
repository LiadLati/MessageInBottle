import { useEffect, useMemo, useState } from 'react';
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
import { LetterPaper } from '../components/LetterPaper.js';
import { SeaChart } from '../components/SeaChart.js';
import { Empty, ErrorNote, Loading, Screen } from '../components/ui.js';
import { formatDuration, newIdempotencyKey } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';
import { useSession } from '../state/session.js';

type Step = 'friend' | 'compose' | 'preview' | 'released';

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

export function WriteScreen({ onReleased }: { onReleased: (bottle: SentBottleDto) => void }) {
  const { user } = useSession();
  const [step, setStep] = useState<Step>('friend');
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [preview, setPreview] = useState<ReleasePreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<Error | null>(null);
  const [releaseError, setReleaseError] = useState<Error | null>(null);
  const [releasing, setReleasing] = useState(false);
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

  const release = async () => {
    if (!draft.recipient || !validation.ok) return;
    setReleasing(true);
    setReleaseError(null);
    try {
      // The same key is reused on retry so a flaky network can never launch two bottles.
      const res = await api.release({
        recipientId: draft.recipient.id,
        text: draft.text,
        font: draft.font,
        idempotencyKey: draft.idempotencyKey,
      });
      sessionStorage.removeItem(DRAFT_KEY);
      setDraft({
        recipient: null,
        text: '',
        font: DEFAULT_LETTER_FONT,
        idempotencyKey: newIdempotencyKey(),
      });
      setStep('released');
      onReleased(res.bottle);
    } catch (err) {
      // Draft is preserved on any failure (spec §18 #2).
      setReleaseError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setReleasing(false);
    }
  };

  if (!user?.shoreId) {
    return (
      <Screen title="Write">
        <Empty>Choose your shore first — bottles need a place to be thrown from.</Empty>
      </Screen>
    );
  }

  if (step === 'friend') {
    return (
      <Screen title="Write: choose a friend">
        {friends.loading || !friends.data ? (
          <Loading />
        ) : friends.data.friends.length === 0 ? (
          <Empty>You have no approved friends yet. Add one from the Friends tab.</Empty>
        ) : (
          <ul className="list">
            {friends.data.friends.map((f) => (
              <li key={f.id}>
                <button
                  className="list-item as-button"
                  disabled={!f.hasShore}
                  onClick={() => choose(f)}
                >
                  <span>
                    <strong>{f.displayName}</strong> <span className="muted">@{f.username}</span>
                  </span>
                  <span className="muted small">{f.hasShore ? '›' : 'no shore yet'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <ErrorNote error={friends.error} />
      </Screen>
    );
  }

  if (step === 'compose') {
    return (
      <Screen
        title={`To ${draft.recipient?.displayName ?? ''}`}
        actions={
          <button className="btn small" onClick={() => setStep('friend')}>
            Change
          </button>
        }
      >
        <label className="field">
          <span className="row space-between">
            <span>Your letter</span>
            <span className={`small ${characters > LETTER_MAX_CHARACTERS ? 'over' : 'muted'}`}>
              {characters} / {LETTER_MAX_CHARACTERS}
            </span>
          </span>
          <textarea
            dir="auto"
            rows={10}
            value={draft.text}
            onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
            style={{
              fontFamily: FONT_DEFINITIONS[draft.font].cssFamily,
              fontStyle: FONT_DEFINITIONS[draft.font].cssStyle ?? 'normal',
            }}
            placeholder="Dear…"
          />
        </label>
        <fieldset className="font-picker">
          <legend>Visual font</legend>
          <div className="row wrap">
            {LETTER_FONTS.map((f) => (
              <label key={f} className={`chip${draft.font === f ? ' selected' : ''}`}>
                <input
                  type="radio"
                  name="font"
                  value={f}
                  checked={draft.font === f}
                  onChange={() => setDraft((d) => ({ ...d, font: f }))}
                />
                <span
                  style={{
                    fontFamily: FONT_DEFINITIONS[f].cssFamily,
                    fontStyle: FONT_DEFINITIONS[f].cssStyle ?? 'normal',
                  }}
                >
                  {FONT_DEFINITIONS[f].label}
                </span>
              </label>
            ))}
          </div>
          <p className="muted small">Fonts change the look only. Your words are never rewritten.</p>
        </fieldset>
        {draft.text.length > 0 ? <LetterPaper text={draft.text} font={draft.font} /> : null}
        {!validation.ok && draft.text.length > 0 ? (
          <p className="note">
            {validation.reason === 'too_long'
              ? 'Too long: trim a little.'
              : validation.reason === 'too_many_bytes'
                ? 'Too large to store; shorten it.'
                : 'Write something first.'}
          </p>
        ) : null}
        <button className="btn primary" disabled={!validation.ok} onClick={goPreview}>
          Preview route
        </button>
      </Screen>
    );
  }

  if (step === 'preview') {
    const p = preview;
    const canRelease = p?.eligible === true && acknowledged && !releasing;
    return (
      <Screen
        title="Preview and release"
        actions={
          <button className="btn small" onClick={() => setStep('compose')}>
            Edit
          </button>
        }
      >
        {chart.data && p?.route ? (
          <SeaChart
            chart={chart.data}
            bottles={[]}
            highlightRoute={p.route.points}
            originShoreId={p.originShore?.id}
            destinationShoreId={p.destinationShore?.id}
          />
        ) : null}
        {!p && !previewError ? <Loading /> : null}
        {p ? (
          <dl className="passport">
            <dt>From</dt>
            <dd>
              {user.displayName} · {p.originShore?.name ?? '—'}
            </dd>
            <dt>To</dt>
            <dd>
              {draft.recipient?.displayName} · {p.destinationShore?.name ?? '—'}
            </dd>
            <dt>Planned journey</dt>
            <dd>
              {p.route
                ? `about ${formatDuration(p.route.plannedDurationMs)} along ${p.route.nodeIds.length - 1} passages`
                : 'no connected route'}
            </dd>
          </dl>
        ) : null}
        {p && !p.eligible ? <p className="note note-error">{rejectionCopy(p.rejection)}</p> : null}
        <ErrorNote error={previewError} />
        <LetterPaper text={draft.text} font={draft.font} />
        <label className="check">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            I understand this letter may become publicly readable if stranded, may be discarded by a
            stranger, or may be lost forever. It contains nothing sensitive or urgent.
          </span>
        </label>
        <button className="btn primary" disabled={!canRelease} onClick={release}>
          {releasing ? 'Releasing…' : 'Release the bottle'}
        </button>
        {releaseError ? (
          <p className="note note-error" role="alert">
            {releaseError instanceof ApiError && releaseError.code === 'release_rejected'
              ? releaseError.message
              : `Release failed: ${releaseError.message}. Your draft is safe.`}
          </p>
        ) : null}
      </Screen>
    );
  }

  return (
    <Screen title="Released">
      <p>Your bottle is at sea. Follow it on the Ocean tab.</p>
      <button className="btn" onClick={() => setStep('friend')}>
        Write another
      </button>
    </Screen>
  );
}

function rejectionCopy(rejection: ReleasePreviewResponse['rejection']): string {
  switch (rejection) {
    case 'sender_has_no_shore':
      return 'Choose your shore before releasing a bottle.';
    case 'recipient_has_no_shore':
      return 'Your friend has not chosen a shore yet.';
    case 'shore_full':
      return "Your friend's shore is full right now. Your draft is kept; try again later.";
    case 'route_unavailable':
      return 'No connected sea route reaches that shore.';
    case 'not_friends':
      return 'You can only send bottles to approved friends.';
    case 'self_send':
      return 'A bottle cannot be addressed to yourself.';
    default:
      return 'Delivery to this friend is unavailable.';
  }
}
