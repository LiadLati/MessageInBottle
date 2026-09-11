import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/format.js';
import { ShoreScene, THROW_BEATS, THROW_TOTAL_S, type ThrowController } from './ShoreScene.js';

export type ReleaseStatus = 'releasing' | 'committed' | 'failed';

interface Props {
  status: ReleaseStatus;
  onFinished: () => void;
  onFailed: () => void;
}

// The nine-beat release (ANIMATION_STORYBOARD.md §A). The release request runs independently of
// playback: the sequence may finish before the server answers, in which case it holds on the
// floating frame; the map appears only on commit; a failure rewinds to the sealed letter.
export function ReleaseSequence({ status, onFinished, onFailed }: Props) {
  const [t, setT] = useState(0);
  const [done, setDone] = useState(false);
  const controllerRef = useRef<ThrowController | null>(null);
  const startRef = useRef<number | null>(null);
  const [reduced] = useState(() => prefersReducedMotion());
  // The clock starts when the scene can draw (or after a short grace period on slow devices) so
  // the beats are seen, not skipped while textures load.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), 2500);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (done || !armed) return;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (reduced) {
      // Three stills — sealed, in the air, floating — with the same copy and server calls.
      const stills = [1.3, 2.1, 3.2];
      let i = 0;
      const step = () => {
        const v = stills[i]!;
        setT(v);
        controllerRef.current?.seek(v);
        i++;
        if (i < stills.length) timer = setTimeout(step, 900);
        else timer = setTimeout(() => setDone(true), 900);
      };
      step();
      return () => clearTimeout(timer);
    }
    const tick = (now: number) => {
      if (startRef.current === null) startRef.current = now;
      const v = Math.min(THROW_TOTAL_S, (now - startRef.current) / 1000);
      setT(v);
      controllerRef.current?.seek(v);
      if (v < THROW_TOTAL_S) raf = requestAnimationFrame(tick);
      else setDone(true);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [done, reduced, armed]);

  useEffect(() => {
    if (status === 'failed') onFailed();
  }, [status, onFailed]);

  useEffect(() => {
    if (done && status === 'committed') onFinished();
  }, [done, status, onFinished]);

  const skip = () => {
    setDone(true);
    controllerRef.current?.seek(THROW_TOTAL_S);
    setT(THROW_TOTAL_S);
  };

  const beatIndex = Math.max(
    0,
    THROW_BEATS.findIndex(
      (b, i) => t >= b.at && (THROW_BEATS[i + 1] ? t < THROW_BEATS[i + 1]!.at : true),
    ),
  );
  const beat = THROW_BEATS[beatIndex]!;
  const waiting = done && status === 'releasing';

  return (
    <div className="world-screen" role="dialog" aria-label="Releasing the bottle" onClick={skip}>
      <div className="world-layer">
        <ShoreScene
          mode="throw"
          onController={(c) => {
            controllerRef.current = c;
            if (c) setArmed(true);
          }}
        />
      </div>
      <div className="scrim scrim-throw" />
      <div className="beat-title" aria-live="polite">
        <div className="t-eyebrow">
          Beat {String(beatIndex + 1).padStart(2, '0')} of{' '}
          {String(THROW_BEATS.length).padStart(2, '0')}
        </div>
        <div className="t-beat">{waiting ? 'Waiting for the sea…' : beat.title}</div>
      </div>
      <div className="transport" onClick={(e) => e.stopPropagation()}>
        <div className="status">
          <span className="pulse-dot" aria-hidden />
          <span className="grow">
            {status === 'committed' ? 'The sea has it.' : 'Releasing to the sea…'}
          </span>
          <span className="t-numeric" style={{ color: 'rgba(255,248,236,.7)' }}>
            {t.toFixed(1)}s
          </span>
        </div>
        <div className="ticks" aria-hidden>
          {THROW_BEATS.map((b, i) => (
            <span key={b.name} className={i <= beatIndex ? 'done' : ''} />
          ))}
        </div>
        <div className="footer">
          <span>
            {THROW_BEATS.slice(0, 5)
              .map((b) => b.name)
              .join(' · ')}
          </span>
          <button type="button" onClick={skip} disabled={done}>
            skip
          </button>
        </div>
      </div>
    </div>
  );
}
