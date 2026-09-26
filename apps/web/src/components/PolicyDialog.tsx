import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PUBLISHED_DOCUMENTS, type DocumentId } from '@mib/shared';
import { Icon } from '../design/Icon.js';
import { focusableIn } from '../lib/focusTrap.js';
import { restoreFocus, useModalKeys } from '../lib/modal.js';
import { PolicyDocumentView } from './PolicyDocumentView.js';
import { TabList, tabPanelProps } from './Tabs.js';

// The three documents, readable before there is an account and again from account settings.
// A modal so a half-filled registration form survives the reading; focus stays inside, Escape
// and the close button return it to where it was.
export function PolicyDialog({ initial, onClose }: { initial: DocumentId; onClose: () => void }) {
  const [current, setCurrent] = useState<DocumentId>(initial);
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const tabsBase = `policy${useId().replace(/:/g, '')}`;
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
      restoreFocus(previous);
    };
  }, []);

  // Switching documents starts the reader at the top of the new one.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [current]);

  useModalKeys(dialogRef, onClose);

  return createPortal(
    <div
      ref={dialogRef}
      className="policy-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}

      tabIndex={-1}
    >
      <div className="policy-dialog-bar">
        <button type="button" className="glass-control" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
        <div className="grow">
          <span className="t-eyebrow">SeaYou</span>
        </div>
      </div>
      <TabList
        base={tabsBase}
        className="policy-tabs"
        tabClassName="btn-secondary"
        label="Documents"
        items={PUBLISHED_DOCUMENTS.map((d) => d.id)}
        selected={current}
        onSelect={setCurrent}
        labelOf={(id) => PUBLISHED_DOCUMENTS.find((d) => d.id === id)?.title ?? id}
      />
      {/* Focusable so the keyboard can scroll the document (audit A11Y-001). */}
      <div ref={scrollRef} className="policy-scroll" {...tabPanelProps(tabsBase, current)}>
        <PolicyDocumentView doc={doc} headingId={headingId} />
      </div>
    </div>,
    document.body,
  );
}
