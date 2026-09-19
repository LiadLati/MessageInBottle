import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SentBottleSummaryDto } from '@mib/shared';
import { Icon } from '../design/Icon.js';
import { focusableIn, nextTabTarget } from '../lib/focusTrap.js';
import { formatDuration, prefersReducedMotion } from '../lib/format.js';
import type { BottleWeather } from '../lib/oceanWeather.js';
import { ShoreScene } from './ShoreScene.js';

interface Props {
  // The selected bottle, or null when it has left the list (opened, or no longer served).
  bottle: SentBottleSummaryDto | null;
  // The very same weather state that drives the marker glyph and the card chip.
  weather: BottleWeather;
  phase: 'day' | 'night';
  onBack: () => void;
}

const CLOSE_MS = 260;
const CLOSE_MS_REDUCED = 120;

// Bottle at Sea (handoff v2.0): a dedicated real-time view of one bottle on open water. It is a
// read-only depiction of state the map already holds — opening, watching or closing it changes
// no weather, progress, route or outcome. The map underneath stays mounted and paused, so
// "Back to map" restores the same centre, zoom and selected card by construction.
//
// Dialog semantics like the letter modal: the app shell is `inert`, focus is trapped and
// restored, Escape closes. No navigation is drawn — Back to map is the only exit. No audio.
export function SeaViewer({ bottle, weather, phase, onBack }: Props) {
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const atSea = bottle?.state === 'at_sea';
  // The scene shows this bottle's weather while it is at sea; once it has landed there is
  // nothing to depict, so the water settles and the card says so.
  const sceneWeather = atSea ? weather : 'calm';
  const name = bottle?.recipient.displayName ?? 'your friend';

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = [...document.body.children].filter(
      (el) => el !== dialogRef.current?.parentElement,
    );
    for (const el of siblings) el.setAttribute('inert', '');
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Back to map is the first focus target on the sea screen.
    dialogRef.current?.querySelector<HTMLElement>('.sea-back')?.focus();
    return () => {
      for (const el of siblings) el.removeAttribute('inert');
      document.body.style.overflow = bodyOverflow;
      previous?.focus();
    };
  }, []);

  const close = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onBack, prefersReducedMotion() ? CLOSE_MS_REDUCED : CLOSE_MS);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const target = nextTabTarget(
      focusableIn(dialogRef.current),
      document.activeElement,
      e.shiftKey,
    );
    if (target) {
      e.preventDefault();
      target.focus();
    }
  };

  // An outcome that commits while the viewer is open is shown as the saved state: the viewer
  // reconciles to what the server decided and never invents a landing for a lost bottle.
  const lost = bottle?.state === 'lost' ? (bottle.outcome?.reason ?? 'adrift') : null;
  const status = !bottle
    ? 'no longer at sea'
    : lost
      ? lost === 'sunk'
        ? 'has sunk'
        : 'is adrift'
      : !atSea
        ? 'has landed'
        : sceneWeather === 'storm'
          ? 'in a storm'
          : 'calm';
  const meta = !bottle
    ? 'This bottle is no longer at sea.'
    : lost
      ? lost === 'sunk'
        ? 'Lost at sea. Its journey has ended.'
        : 'Swept off course. It drifts in the public ocean, sealed.'
      : !atSea
        ? `Arrived at ${bottle.destinationShore.name}. Its journey is complete.`
        : `${formatDuration(bottle.elapsedMs)} at sea · ${sceneWeather === 'storm' ? 'rough water' : 'calm water'} · watching does not change the weather`;

  return createPortal(
    <div
      className={`sea-viewer ${sceneWeather}${closing ? ' closing' : ''}`}
      data-weather={sceneWeather}
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        className="sea-viewer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="sea-world" aria-hidden>
          <ShoreScene mode="sea" weather={sceneWeather} phase={phase} />
        </div>
        <div className="sea-scrim" aria-hidden />
        <button type="button" className="sea-back" onClick={close}>
          <Icon name="back" size={18} />
          Back to map
        </button>
        {/* Announced once on open: the state in words, never by colour or motion alone. */}
        <p className="sr-only" role="status" aria-live="polite">
          Bottle to {name}, {status}. Viewing does not change the journey.
        </p>
        <section className="sea-card" aria-label="Bottle at sea">
          <div className="row">
            <h2 id={titleId} className="t-card-title grow">
              To {name}
            </h2>
            {bottle && atSea ? (
              sceneWeather === 'storm' ? (
                <span className="status-chip storm-chip">
                  <span aria-hidden>▲</span>
                  In a storm
                </span>
              ) : (
                <span className="status-chip status-at_sea">
                  <span aria-hidden>◦</span>
                  At sea
                </span>
              )
            ) : null}
          </div>
          <p className="t-meta sea-meta">{meta}</p>
        </section>
      </div>
    </div>,
    document.body,
  );
}
