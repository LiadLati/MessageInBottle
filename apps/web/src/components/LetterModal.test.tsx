// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenedLetterDto } from '@mib/shared';
import type * as ClientModule from '../api/client.js';

// A finder's one reading, at the component level (product decision 12, amended 2026-09-26): the
// letter is served once and can never be reopened, so it ends only through an explicit, confirmed
// "Finish reading" — Close, a stray backdrop tap and Escape all ask first. There is no resume.
// Also audit FE-R-001: the report form lives in a panel that scrolls inside the reader.

const api = vi.hoisted(() => ({
  reportLetter: vi.fn(),
  blockFoundWriter: vi.fn(),
  closeReading: vi.fn(),
}));
vi.mock('../api/client.js', async (actual) => ({
  ...(await actual<typeof ClientModule>()),
  api,
}));

import { focusableIn } from '../lib/focusTrap.js';
import { useLetterReader } from '../state/letterReader.js';
import { LetterModal } from './LetterModal.js';

const found = (id = 'btl_found'): OpenedLetterDto => ({
  bottle: {
    id,
    source: 'public',
    state: 'lost',
    sender: null,
    originShore: null,
    releasedAt: '2026-09-20T10:00:00.000Z',
    deliveredAt: null,
    openedAt: '2026-09-22T10:00:00.000Z',
    journeyDurationMs: 3 * 24 * 60 * 60 * 1000,
  },
  letter: { text: 'Dear stranger, the tide was kind today.', font: 'print', characters: 39 },
  aging: { yellowing: 0.2, wear: 0.1, tears: [], stains: [] },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  api.closeReading.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function reader(props: Partial<Parameters<typeof LetterModal>[0]> = {}) {
  const onClose = vi.fn();
  const onFinish = vi.fn();
  render(
    <LetterModal
      letter={found()}
      justOpened
      oneTime
      reportable
      onClose={onClose}
      onFinish={onFinish}
      {...props}
    />,
  );
  // Closing animates, then calls back.
  const settle = () => act(() => void vi.advanceTimersByTime(400));
  const confirmation = () => screen.queryByRole('group', { name: 'Finish reading' });
  return { onClose, onFinish, settle, confirmation, dialog: screen.getByRole('dialog') };
}

describe('a one-time reading is never ended by accident', () => {
  for (const [how, act_] of [
    [
      'a stray backdrop tap',
      () => fireEvent.click(document.querySelector('.letter-modal-backdrop')!),
    ],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['the Close button', () => fireEvent.click(screen.getByRole('button', { name: /^Close/ }))],
  ] as const) {
    it(`${how} asks to finish instead of closing`, () => {
      const { onClose, onFinish, settle, confirmation } = reader();
      act_();
      settle();
      expect(confirmation()).not.toBeNull();
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
      expect(onFinish).not.toHaveBeenCalled();
    });
  }

  it('cancelling the warning keeps the letter open and returns focus', () => {
    const { onClose, onFinish, settle, confirmation } = reader();
    fireEvent.click(screen.getByRole('button', { name: 'Finish reading' }));
    expect(confirmation()?.textContent).toMatch(/closes for good/);
    const keep = screen.getByRole('button', { name: 'Keep reading' });
    expect(document.activeElement).toBe(keep);
    fireEvent.click(keep);
    settle();
    expect(confirmation()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Finish reading' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('Escape during the warning cancels the warning, not the reading', () => {
    const { onClose, onFinish, settle, confirmation } = reader();
    fireEvent.click(screen.getByRole('button', { name: 'Finish reading' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    settle();
    expect(confirmation()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('explicitly confirming finishes the reading', () => {
    const { onClose, onFinish, settle, confirmation } = reader();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(
      [...confirmation()!.querySelectorAll('button')].find(
        (b) => b.textContent === 'Finish reading',
      )!,
    );
    settle();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says plainly that the reading cannot be reopened, and promises no resume', () => {
    const { dialog } = reader();
    expect(dialog.textContent).toMatch(/cannot be opened again/);
    expect(dialog.textContent).not.toMatch(/15 minutes|return to it/i);
  });

  it('never names the writer of a found letter', () => {
    const { dialog } = reader();
    expect(dialog.textContent).toMatch(/Found adrift/);
    expect(dialog.textContent).not.toMatch(/From /);
  });

  it('closes an ordinary letter at once, with no finish control', () => {
    const { onClose, settle } = reader({ oneTime: false, reportable: false });
    expect(screen.queryByRole('button', { name: 'Finish reading' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('the reader state over the Ocean: one reading, no resume', () => {
  const opened = () => {
    const hook = renderHook(() => useLetterReader());
    act(() => hook.result.current.show({ letter: found(), justOpened: true }));
    return hook;
  };

  it('a confirmed finish ends the reading on the server, once, even in a StrictMode build', () => {
    const { result } = renderHook(() => useLetterReader(), { wrapper: StrictMode });
    act(() => result.current.show({ letter: found(), justOpened: true }));
    act(() => result.current.finish());
    expect(result.current.reading).toBeNull();
    expect(api.closeReading).toHaveBeenCalledTimes(1);
    expect(api.closeReading).toHaveBeenCalledWith('btl_found');
  });

  it('offers nothing to return to once the reader is gone', () => {
    const { result } = opened();
    act(() => result.current.finish());
    expect(Object.keys(result.current).sort()).toEqual(['close', 'finish', 'reading', 'show']);
  });

  it('leaving the Ocean with a found letter open ends the reading', () => {
    const { unmount } = opened();
    unmount();
    expect(api.closeReading).toHaveBeenCalledWith('btl_found');
  });

  it('asks the browser to warn before a reload while a found letter is open', () => {
    const { result } = opened();
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    act(() => result.current.finish());
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('the sender re-reading their own letter closes plainly and tells the server nothing', () => {
    const { result, unmount } = renderHook(() => useLetterReader());
    const own = found('btl_own');
    own.bottle.source = 'shore';
    act(() => result.current.show({ letter: own, justOpened: false }));
    act(() => result.current.close());
    act(() => result.current.show({ letter: own, justOpened: false }));
    unmount();
    expect(api.closeReading).not.toHaveBeenCalled();
  });
});

describe('the report form fits a short screen (FE-R-001)', () => {
  it('opens in a panel that marks the dialog, with its actions in a pinned row', () => {
    const { dialog } = reader();
    fireEvent.click(screen.getByRole('button', { name: 'Report this letter' }));
    expect(dialog.classList.contains('has-panel')).toBe(true);
    const form = screen.getByRole('form', { name: 'Report this letter' });
    const panel = form.closest('.letter-modal-report')!;
    expect(panel).not.toBeNull();
    const actions = form.querySelector('.report-actions')!;
    expect(actions.textContent).toMatch(/Send report/);
    expect(actions.textContent).toMatch(/Cancel/);
  });

  it('keeps every control reachable by keyboard, in order, trapped inside the reader', () => {
    reader();
    fireEvent.click(screen.getByRole('button', { name: 'Report this letter' }));
    const dialog = screen.getByRole('dialog');
    const order = focusableIn(dialog);
    const at = (el: HTMLElement) => order.indexOf(el);
    const reason = screen.getByRole('combobox');
    const explain = screen.getByRole('textbox');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const send = screen.getByRole('button', { name: 'Send report' });
    // Every form control is in the Tab order, in reading order, Send after Cancel.
    for (const el of [reason, explain, cancel, send]) expect(at(el)).toBeGreaterThan(-1);
    expect(at(reason)).toBeLessThan(at(explain));
    expect(at(explain)).toBeLessThan(at(cancel));
    expect(at(cancel)).toBeLessThan(at(send));
    // Nothing hidden behind the panel is left in the order (the footer is not rendered).
    expect(screen.queryByRole('button', { name: 'Finish reading' })).toBeNull();
    // Tab past the last control wraps to the first; Shift+Tab from the first wraps to the last.
    order.at(-1)!.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(order[0]);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(order.at(-1));
  });
});
