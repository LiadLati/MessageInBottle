import { useEffect, useRef } from 'react';

// Over the Ocean while a finder's one reading is closed for now but still open on the server,
// or once it has ended (audit FE-R-002). The live region is always present, so a screen reader
// announces the message when it appears; the Return button takes focus when a letter has just
// been closed, so the way back is one key away.
export function ReadingResume({
  paused,
  ended,
  onResume,
  onForget,
}: {
  paused: boolean;
  ended: boolean;
  onResume: () => void;
  onForget: () => void;
}) {
  const returnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (paused) returnRef.current?.focus();
  }, [paused]);
  const visible = paused || ended;
  return (
    <div className={visible ? 'reading-resume' : 'sr-only'} role="status">
      {paused ? (
        <>
          <span>Your one reading is still open for a few minutes.</span>
          <button ref={returnRef} type="button" className="btn-primary" onClick={onResume}>
            Return to the letter
          </button>
        </>
      ) : ended ? (
        <>
          <span>That reading has ended.</span>
          <button type="button" className="btn-ghost" onClick={onForget}>
            Dismiss
          </button>
        </>
      ) : null}
    </div>
  );
}
