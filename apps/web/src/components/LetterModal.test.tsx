// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenedLetterDto } from '@mib/shared';
import type * as ClientModule from '../api/client.js';

// Audit FE-R-001 and FE-R-002, at the component level: the report form lives in a panel that
// scrolls inside the reader with its actions pinned, and a finder's one-time reading ends only
// on an explicit, confirmed "Finish reading" — never on a backdrop tap or Escape.

const api = vi.hoisted(() => ({
  reportLetter: vi.fn(),
  blockFoundWriter: vi.fn(),
  activeReading: vi.fn(),
  closeReading: vi.fn(),
}));
vi.mock('../api/client.js', async (actual) => ({
  ...(await actual<typeof ClientModule>()),
  api,
}));

import { StrictMode } from 'react';
import { focusableIn } from '../lib/focusTrap.js';
import { ReadingResume } from './ReadingResume.js';
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
  readingExpiresAt: '2026-09-22T10:15:00.000Z',
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  // Ten minutes into the found letter's fifteen-minute reading.
  vi.setSystemTime(Date.parse('2026-09-22T10:05:00.000Z'));
  api.closeReading.mockResolvedValue(undefined);
  api.activeReading.mockResolvedValue({ reading: null });
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
  return { onClose, onFinish, settle, dialog: screen.getByRole('dialog') };
}

describe('a one-time reading is not ended by accident (FE-R-002)', () => {
  it('a backdrop tap only dismisses the reader', () => {
    const { onClose, onFinish, settle } = reader();
    fireEvent.click(document.querySelector('.letter-modal-backdrop')!);
    settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('Escape only dismisses the reader', () => {
    const { onClose, onFinish, settle } = reader();
    fireEvent.keyDown(document, { key: 'Escape' });
    settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('"Finish reading" asks first; "Keep reading" leaves the reading open and returns focus', () => {
    const { onClose, onFinish, settle } = reader();
    const finishButton = screen.getByRole('button', { name: 'Finish reading' });
    fireEvent.click(finishButton);
    const group = screen.getByRole('group', { name: 'Finish reading' });
    expect(group.textContent).toMatch(/closes for good/);
    const keep = screen.getByRole('button', { name: 'Keep reading' });
    expect(document.activeElement).toBe(keep);
    fireEvent.click(keep);
    settle();
    expect(screen.queryByRole('group', { name: 'Finish reading' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Finish reading' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('Escape during the confirmation cancels the confirmation, not the reading', () => {
    const { onClose, onFinish, settle } = reader();
    fireEvent.click(screen.getByRole('button', { name: 'Finish reading' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    settle();
    expect(screen.queryByRole('group', { name: 'Finish reading' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('confirming ends the reading', () => {
    const { onClose, onFinish, settle } = reader();
    fireEvent.click(screen.getByRole('button', { name: 'Finish reading' }));
    const group = screen.getByRole('group', { name: 'Finish reading' });
    fireEvent.click(
      [...group.querySelectorAll('button')].find((b) => b.textContent === 'Finish reading')!,
    );
    settle();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('never names the writer of a found letter', () => {
    const { dialog } = reader();
    expect(dialog.textContent).toMatch(/Found adrift/);
    expect(dialog.textContent).not.toMatch(/From /);
  });

  it('offers no finish control on an ordinary letter', () => {
    reader({ oneTime: false, reportable: false });
    expect(screen.queryByRole('button', { name: 'Finish reading' })).toBeNull();
  });
});

describe('the reader state over the Ocean (FE-R-002)', () => {
  const setup = async () => {
    const hook = renderHook(() => useLetterReader());
    await act(async () => {});
    act(() => hook.result.current.show({ letter: found(), justOpened: true }));
    return hook;
  };

  it('dismissing sends nothing to the server and offers the letter back', async () => {
    const { result } = await setup();
    act(() => result.current.dismiss());
    expect(result.current.reading).toBeNull();
    expect(result.current.paused?.bottle.id).toBe('btl_found');
    expect(api.closeReading).not.toHaveBeenCalled();
  });

  it('returning within the window resumes the same reading from the server', async () => {
    const { result } = await setup();
    act(() => result.current.dismiss());
    api.activeReading.mockResolvedValue({ reading: found() });
    act(() => result.current.resume());
    await act(async () => {});
    expect(result.current.reading?.letter.bottle.id).toBe('btl_found');
    expect(result.current.paused).toBeNull();
    expect(api.closeReading).not.toHaveBeenCalled();
  });

  it('after the window has run out, says the reading has ended', async () => {
    const { result } = await setup();
    act(() => result.current.dismiss());
    api.activeReading.mockResolvedValue({ reading: null });
    act(() => result.current.resume());
    await act(async () => {});
    expect(result.current.reading).toBeNull();
    expect(result.current.ended).toBe(true);
  });

  it('a confirmed finish ends the reading on the server at once', async () => {
    const { result } = await setup();
    act(() => result.current.finish());
    expect(api.closeReading).toHaveBeenCalledWith('btl_found');
    expect(result.current.reading).toBeNull();
    expect(result.current.paused).toBeNull();
  });

  it('a reload brings an open reading straight back', async () => {
    api.activeReading.mockResolvedValue({ reading: found() });
    const { result } = renderHook(() => useLetterReader());
    await act(async () => {});
    expect(result.current.reading?.letter.bottle.id).toBe('btl_found');
    expect(api.closeReading).not.toHaveBeenCalled();
  });

  it('the sender re-reading their own letter leaves nothing to resume', async () => {
    const { result } = renderHook(() => useLetterReader());
    await act(async () => {});
    const own = found('btl_own');
    own.bottle.source = 'shore';
    act(() => result.current.show({ letter: own, justOpened: false }));
    act(() => result.current.dismiss());
    expect(result.current.paused).toBeNull();
    act(() => result.current.finish());
    expect(api.closeReading).not.toHaveBeenCalled();
  });
});

describe('review follow-ups (FE-R-002)', () => {
  it('a confirmed finish sends exactly one close, even in a development (StrictMode) build', async () => {
    const { result } = renderHook(() => useLetterReader(), { wrapper: StrictMode });
    await act(async () => {});
    act(() => result.current.show({ letter: found(), justOpened: true }));
    act(() => result.current.finish());
    expect(api.closeReading).toHaveBeenCalledTimes(1);
  });

  it('the offer to return lapses when the reading window ends', async () => {
    const { result } = renderHook(() => useLetterReader());
    await act(async () => {});
    act(() => result.current.show({ letter: found(), justOpened: true }));
    act(() => result.current.dismiss());
    expect(result.current.paused).not.toBeNull();
    act(() => void vi.advanceTimersByTime(10 * 60 * 1000 + 1));
    expect(result.current.paused).toBeNull();
    expect(result.current.ended).toBe(true);
    expect(api.closeReading).not.toHaveBeenCalled();
  });

  it('the prompt is a live region that is always present, and its Return button takes focus', () => {
    const onResume = vi.fn();
    const { rerender } = render(
      <ReadingResume paused={false} ended={false} onResume={onResume} onForget={vi.fn()} />,
    );
    const live = screen.getByRole('status');
    expect(live.textContent).toBe('');
    rerender(<ReadingResume paused ended={false} onResume={onResume} onForget={vi.fn()} />);
    expect(screen.getByRole('status')).toBe(live);
    expect(live.textContent).toMatch(/still open/);
    const back = screen.getByRole('button', { name: 'Return to the letter' });
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    expect(onResume).toHaveBeenCalledTimes(1);
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
