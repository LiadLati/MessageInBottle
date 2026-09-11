import { useState } from 'react';
import type { OpenedLetterDto } from '@mib/shared';
import { LetterPaper } from '../components/LetterPaper.js';
import { Icon } from '../design/Icon.js';
import { formatDuration } from '../lib/format.js';

interface Props {
  letter: OpenedLetterDto;
  justOpened: boolean;
  onBack: () => void;
}

// S8 · Opened letter — a full-screen parchment reader with exactly two controls (Back to shore,
// Readable Print); aging sits under the text; the text is selectable, direction-aware (dir=auto)
// and available to assistive tech from the first frame (storyboard §D).
export function OpenedLetterScreen({ letter, justOpened, onBack }: Props) {
  const [readable, setReadable] = useState(false);
  const b = letter.bottle;
  return (
    <div className="opened-letter" style={{ background: 'var(--paper-parchment)' }}>
      {justOpened ? <div className="veil" aria-hidden /> : null}
      <div className="opened-letter-top letter-chrome">
        <button type="button" className="btn-ghost" onClick={onBack}>
          <Icon name="back" size={14} />
          Back to shore
        </button>
        <span className="grow provenance">
          From {b.sender.displayName} · {formatDuration(b.journeyDurationMs)} at sea
        </span>
        <button
          type="button"
          className="btn-ghost"
          aria-pressed={readable}
          onClick={() => setReadable((r) => !r)}
          aria-label="Readable Print"
        >
          <Icon name="readable-print" size={14} />
          Aa
        </button>
      </div>
      <LetterPaper
        text={letter.letter.text}
        font={letter.letter.font}
        aging={letter.aging}
        full
        readable={readable}
        toolbar="none"
      />
      <p className="letter-chrome opened-letter-foot">
        Opening ended its journey. Fonts and aging change the look only, never the words.
      </p>
    </div>
  );
}
