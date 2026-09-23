import { useEffect, useRef, type RefObject } from 'react';
import { focusableIn, nextTabTarget } from './focusTrap.js';

// Open dialogs, topmost last. Only the topmost one answers the keyboard, so a confirmation
// opened over a letter closes by itself and leaves the letter open.
const stack: HTMLElement[] = [];

/**
 * Escape and the Tab trap for a modal, bound to the document rather than to the dialog: when
 * the focused control unmounts, focus falls to <body>, outside the dialog, and a handler on the
 * dialog element stops firing (audit A11Y-005). `onEscape: null` makes Escape do nothing, for
 * dialogs that must be answered.
 */
export function useModalKeys(
  ref: RefObject<HTMLElement | null>,
  onEscape: (() => void) | null,
): void {
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    stack.push(el);
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== el) return;
      if (e.key === 'Escape') {
        if (escape.current) {
          e.preventDefault();
          escape.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const target = nextTabTarget(focusableIn(el), document.activeElement, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      stack.splice(stack.indexOf(el), 1);
    };
  }, [ref]);
}

/**
 * Return focus to where it was before a dialog opened. When that control has gone (picking a
 * bottle up removes the button that opened it), focus goes to the screen's heading instead of
 * being dropped on <body> (audit A11Y-013).
 */
export function restoreFocus(previous: HTMLElement | null): void {
  if (previous?.isConnected && !previous.closest('[inert]')) {
    previous.focus();
    return;
  }
  const fallback =
    document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('main');
  if (!fallback) return;
  if (!fallback.hasAttribute('tabindex')) fallback.setAttribute('tabindex', '-1');
  fallback.focus();
}
