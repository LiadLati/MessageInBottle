import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { FontDefinition, LetterFont } from '@mib/shared';
import { Icon } from '../design/Icon.js';
import { letterTextStyle } from './LetterPaper.js';

interface Props {
  label: string;
  options: FontDefinition[];
  value: LetterFont;
  onChange: (font: LetterFont) => void;
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = options.find((o) => o.id === value) ?? options[0]!;

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

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
          className="font-select-list"
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
