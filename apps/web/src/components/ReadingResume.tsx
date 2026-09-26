// Shown over the Ocean while a finder's one reading is closed for now but still open on the
// server, or once it turns out to have ended (audit FE-R-002).
export function ReadingResume({
  paused,
  onResume,
  onForget,
}: {
  paused: boolean;
  onResume: () => void;
  onForget: () => void;
}) {
  return (
    <div className="reading-resume" role="status">
      {paused ? (
        <>
          <span>Your one reading is still open for a few minutes.</span>
          <button type="button" className="btn-primary" onClick={onResume}>
            Return to the letter
          </button>
        </>
      ) : (
        <>
          <span>That reading has ended.</span>
          <button type="button" className="btn-ghost" onClick={onForget}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
