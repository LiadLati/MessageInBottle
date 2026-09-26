import { useRef, type KeyboardEvent } from 'react';

// The ARIA tabs pattern, implemented rather than only declared (audit A11Y-006): one tab stop
// for the whole list (roving tabindex), arrow keys and Home/End move between tabs and select
// them, and every tab controls a panel that actually exists. Screens render one panel at a
// time, so every tab of a list points at the same panel element, which is labelled by
// whichever tab is selected.
export function tabId(base: string, value: string): string {
  return `${base}-tab-${value}`;
}
export function panelId(base: string): string {
  return `${base}-panel`;
}

/** Props for the single panel a tab list controls. The panel is focusable so it can be read. */
export function tabPanelProps(base: string, selected: string) {
  return {
    id: panelId(base),
    role: 'tabpanel',
    'aria-labelledby': tabId(base, selected),
    tabIndex: 0,
  } as const;
}

export function TabList<T extends string>({
  base,
  label,
  items,
  selected,
  onSelect,
  labelOf,
  className = 'seg-tabs',
  tabClassName,
  controls,
}: {
  base: string;
  label: string;
  items: readonly T[];
  selected: T;
  onSelect: (value: T) => void;
  labelOf: (value: T) => string;
  className?: string;
  tabClassName?: string;
  // The panel this list controls when it is not the list's own (two lists, one panel).
  controls?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (e: KeyboardEvent) => {
    const at = items.indexOf(selected);
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? items[(at + 1) % items.length]
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? items[(at - 1 + items.length) % items.length]
          : e.key === 'Home'
            ? items[0]
            : e.key === 'End'
              ? items[items.length - 1]
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    onSelect(next);
    refs.current.get(next)?.focus();
  };
  return (
    <div className={className} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((value) => {
        const active = value === selected;
        return (
          <button
            key={value}
            ref={(el) => {
              if (el) refs.current.set(value, el);
              else refs.current.delete(value);
            }}
            type="button"
            role="tab"
            id={tabId(base, value)}
            aria-selected={active}
            aria-controls={controls ?? panelId(base)}
            tabIndex={active ? 0 : -1}
            className={
              [tabClassName, active ? 'active' : ''].filter(Boolean).join(' ') || undefined
            }
            onClick={() => onSelect(value)}
          >
            {labelOf(value)}
          </button>
        );
      })}
    </div>
  );
}
