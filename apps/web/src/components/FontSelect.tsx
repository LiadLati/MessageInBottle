import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { FontDefinition, LetterFont } from '@mib/shared';
import { Icon } from '../design/Icon.js';
import { letterTextStyle } from './LetterPaper.js';

interface Props {
  label: string;
  options: FontDefinition[];
  value: LetterFont;
  onChange: (font: LetterFont) => void;
}

// The open list never grows past the space it actually has: it is capped well short of the
// viewport, and it opens upward when there is more room above the trigger than below. Whatever
// does not fit scrolls inside the list, so every face stays reachable on short phones.
const MAX_LIST_HEIGHT = 300;
const COMFORTABLE = 200;
const GAP = 6;
const EDGE = 12;

// How much of the bottom of the viewport is covered by the fixed navigation. The desktop layout
// puts the same element down the left side as a full-height rail, which obstructs nothing here.
function bottomObstruction(): number {
  const nav = document.querySelector('nav.nav');
  if (!nav) return 0;
  const r = nav.getBoundingClientRect();
  const bottomDocked = r.top > window.innerHeight / 2 && r.width > window.innerWidth * 0.6;
  return bottomDocked ? Math.max(0, window.innerHeight - r.top) : 0;
}

// Accessible single-select dropdown (button + listbox) for the visual font. Every option is
// rendered in its own face. The list is data-driven from the shared catalogue, so a new face
// only needs a FontDefinition. Choosing a font changes presentation only, never the text.
export function FontSelect({ label, options, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.id === value),
    ),
  );
  const [placement, setPlacement] = useState({ up: false, maxHeight: COMFORTABLE });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = options.find((o) => o.id === value) ?? options[0]!;

  const measure = useCallback(() => {
    // Measured against the field box, not the trigger: the list is anchored to this element
    // (`top`/`bottom: calc(100% + gap)`), and it also contains the label above the button, so
    // using the trigger would over-estimate the room above by the height of that label.
    const anchor = rootRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - GAP - bottomObstruction() - EDGE;
    const above = rect.top - GAP - EDGE;
    const up = below < COMFORTABLE && above > below;
    const room = Math.max(0, up ? above : below);
    setPlacement({ up, maxHeight: Math.min(MAX_LIST_HEIGHT, room) });
  }, []);

  // Measured before paint so the list is never drawn at the wrong size or on the wrong side.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    // preventScroll matters: focusing the list can otherwise scroll the page to reveal it,
    // which moves the trigger and would leave the size measured a moment ago wrong. Measure
    // once more on the next frame in case anything else shifted the layout.
    listRef.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => measure());
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // Capture phase: the page behind the dropdown scrolls, and so may an ancestor.
    const reflow = () => measure();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', reflow, true);
    window.addEventListener('resize', reflow);
    window.visualViewport?.addEventListener('resize', reflow);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', reflow, true);
      window.removeEventListener('resize', reflow);
      window.visualViewport?.removeEventListener('resize', reflow);
    };
  }, [open, measure]);

  // Keep the highlighted option inside the scrolled area as the selection moves by keyboard.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);

  const choose = (index: number) => {
    const opt = options[index];
    if (opt && opt.id !== 'readable_print') onChange(opt.id);
    setOpen(false);
    buttonRef.current?.focus();
  };
  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      openAt(
        Math.max(
          0,
          options.findIndex((o) => o.id === value),
        ),
      );
    }
  };
  const onListKey = (e: KeyboardEvent) => {
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => Math.min(last, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(last);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(active);
        break;
      case 'Escape':
      case 'Tab':
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        break;
      default: {
        const key = e.key.toLowerCase();
        const idx = options.findIndex((o) => o.label.toLowerCase().startsWith(key));
        if (idx >= 0) setActive(idx);
      }
    }
  };

  const sample = (o: FontDefinition) => ({
    ...letterTextStyle(o.id === 'readable_print' ? 'print' : o.id, o.id === 'readable_print'),
    fontSize: Math.min(22, o.sizePx),
    lineHeight: 1.2,
  });

  return (
    <div className="font-select" ref={rootRef}>
      <span id={`${id}-label`} className="t-label">
        {label}
      </span>
      <button
        ref={buttonRef}
        type="button"
        className="font-select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-value`}
        onClick={() => (open ? setOpen(false) : openAt(active))}
        onKeyDown={onButtonKey}
      >
        <span id={`${id}-value`} style={sample(current)}>
          {current.label}
        </span>
        <Icon name="back" size={14} className={open ? 'rotate-up' : 'rotate-down'} />
      </button>
      {open ? (
        <ul
          ref={listRef}
          className={`font-select-list${placement.up ? ' up' : ''}`}
          style={{ maxHeight: placement.maxHeight }}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={`${id}-label`}
          aria-activedescendant={`${id}-opt-${active}`}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <li
              key={o.id}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={o.id === value}
              className={`font-select-option${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <span style={sample(o)}>{o.label}</span>
              <span className="t-meta">Dear friend, the tide was gentle</span>
              {o.id === value ? <Icon name="check" size={14} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
