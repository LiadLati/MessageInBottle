// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The Android back button, with the native plugin replaced by a recorder: a dialog closes
// first, then history steps back, and from the first screen the app goes to the background.
const listeners = vi.hoisted(() => new Map<string, (e: { canGoBack: boolean }) => void>());
const minimizeApp = vi.hoisted(() => vi.fn());
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: (name: string, fn: (e: { canGoBack: boolean }) => void) => {
      listeners.set(name, fn);
      return Promise.resolve({ remove: () => undefined });
    },
    minimizeApp,
  },
}));
vi.mock('./endpoints.js', () => ({ isNativeApp: true }));

import { useRef } from 'react';
import { cleanup, render } from '@testing-library/react';
import { installNativeShell } from './nativeShell.js';
import { useModalKeys } from './modal.js';

function Dialog({ onEscape }: { onEscape: (() => void) | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalKeys(ref, onEscape);
  return <div ref={ref} role="dialog" aria-modal="true" />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  minimizeApp.mockReset();
});

describe('Android Back', () => {
  it('steps back through history, and backgrounds the app from the first screen', () => {
    installNativeShell();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    listeners.get('backButton')!({ canGoBack: true });
    expect(back).toHaveBeenCalledTimes(1);
    listeners.get('backButton')!({ canGoBack: false });
    expect(minimizeApp).toHaveBeenCalledTimes(1);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('closes the topmost dialog instead of leaving the screen, and never skips an answer-only one', () => {
    installNativeShell();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const close = vi.fn();
    const { unmount } = render(<Dialog onEscape={close} />);
    listeners.get('backButton')!({ canGoBack: true });
    expect(close).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    unmount();

    render(<Dialog onEscape={null} />);
    listeners.get('backButton')!({ canGoBack: true });
    expect(back).not.toHaveBeenCalled();
    expect(minimizeApp).not.toHaveBeenCalled();
  });

  it('re-runs the foreground refresh when the app is resumed', () => {
    installNativeShell();
    const seen: string[] = [];
    document.addEventListener('visibilitychange', () => seen.push('visibility'));
    window.addEventListener('focus', () => seen.push('focus'));
    (listeners.get('resume') as unknown as () => void)();
    expect(seen).toEqual(['visibility', 'focus']);
  });
});
