import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AdminPendingCountsDto } from '@mib/shared';
import { Icon } from '../design/Icon.js';

// The admin icon beside the notification icon: drawn only for an admin account (the server
// refuses every admin request from anyone else). Its menu starts with Reports and Appeals.
// A menu button that behaves like one (audit A11Y-007): opening focuses the first item, arrow
// keys move between items, Escape and a click elsewhere close it and return focus.
export function AdminControl({
  onOpen,
  pending,
}: {
  onOpen: (section: 'reports' | 'appeals') => void;
  pending: AdminPendingCountsDto | null;
}) {
  const total = pending?.total ?? 0;
  const count = (n: number) => (n > 9 ? '9+' : String(n));
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const onMenuKey = (e: ReactKeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'ArrowDown'
        ? items[(at + 1) % items.length]
        : e.key === 'ArrowUp'
          ? items[(at - 1 + items.length) % items.length]
          : e.key === 'Home'
            ? items[0]
            : e.key === 'End'
              ? items[items.length - 1]
              : undefined;
    if (next) {
      e.preventDefault();
      next.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };
  const choose = (section: 'reports' | 'appeals') => {
    setOpen(false);
    onOpen(section);
  };
  return (
    <span className="admin-control" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="glass-control inbox-control"
        aria-label={
          total > 0
            ? `Admin, ${pending!.reports} reports and ${pending!.appeals} appeals waiting`
            : 'Admin'
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="shield" size={18} />
        {total > 0 ? (
          <span className="inbox-count" aria-hidden>
            {count(total)}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="glass-panel admin-menu stack"
          role="menu"
          aria-label="Admin"
          onKeyDown={onMenuKey}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="btn-ghost"
            onClick={() => choose('reports')}
          >
            <Icon name="report" size={14} />
            Reports
            {pending && pending.reports > 0 ? (
              <span className="menu-count">{count(pending.reports)} waiting</span>
            ) : null}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="btn-ghost"
            onClick={() => choose('appeals')}
          >
            <Icon name="archive" size={14} />
            Appeals
            {pending && pending.appeals > 0 ? (
              <span className="menu-count">{count(pending.appeals)} waiting</span>
            ) : null}
          </button>
        </div>
      ) : null}
    </span>
  );
}
