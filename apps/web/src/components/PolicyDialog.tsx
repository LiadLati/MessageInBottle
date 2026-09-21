import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PUBLISHED_DOCUMENTS, type DocumentId } from '@mib/shared';
import { Icon } from '../design/Icon.js';
import { focusableIn, nextTabTarget } from '../lib/focusTrap.js';
import { PolicyDocumentView } from './PolicyDocumentView.js';

// The three documents, readable before there is an account and again from account settings.
// A modal so a half-filled registration form survives the reading; focus stays inside, Escape
// and the close button return it to where it was.
export function PolicyDialog({ initial, onClose }: { initial: DocumentId; onClose: () => void }) {
  const [current, setCurrent] = useState<DocumentId>(initial);
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const doc = PUBLISHED_DOCUMENTS.find((d) => d.id === current) ?? PUBLISHED_DOCUMENTS[0]!;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // The dialog is portaled straight into <body>, so everything beside it goes inert.
    const siblings = [...document.body.children].filter((el) => el !== dialogRef.current);
    for (const el of siblings) el.setAttribute('inert', '');
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    (focusableIn(dialogRef.current!)[0] ?? dialogRef.current)?.focus();
    return () => {
      for (const el of siblings) el.removeAttribute('inert');
      document.body.style.overflow = bodyOverflow;
      previous?.focus();
    };
  }, []);

  // Switching documents starts the reader at the top of the new one.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [current]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
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

  return createPortal(
    <div
      ref={dialogRef}
      className="policy-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div className="policy-dialog-bar">
        <button type="button" className="glass-control" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
        <div className="grow">
          <span className="t-eyebrow">Message in a Bottle</span>
        </div>
      </div>
      <div className="policy-tabs" role="tablist" aria-label="Documents">
        {PUBLISHED_DOCUMENTS.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            className="btn-secondary"
            aria-selected={d.id === current}
            onClick={() => setCurrent(d.id)}
          >
            {d.title}
          </button>
        ))}
      </div>
      <div ref={scrollRef} className="policy-scroll" role="tabpanel">
        <PolicyDocumentView doc={doc} headingId={headingId} />
      </div>
    </div>,
    document.body,
  );
}
