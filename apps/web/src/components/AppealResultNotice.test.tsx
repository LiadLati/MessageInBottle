// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationDto } from '@mib/shared';
import type * as ClientModule from '../api/client.js';

// Manual review round 1, item 5: the appeal result popup. Shown once; dismissing it tells the
// server (which marks that notification read and keeps it in the history).

const api = vi.hoisted(() => ({ appealResultSeen: vi.fn() }));
vi.mock('../api/client.js', async (actual) => ({
  ...(await actual<typeof ClientModule>()),
  api,
}));

import { AppealResultNotice } from './AppealResultNotice.js';

const result = (kind: NotificationDto['kind'], message: string): NotificationDto => ({
  id: 'ntf_1',
  type: 'moderation',
  kind,
  bottleId: null,
  message,
  createdAt: '2026-10-26T17:35:00.000Z',
  readAt: null,
});

beforeEach(() => {
  api.appealResultSeen.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the appeal result popup', () => {
  it('says an accepted appeal withdrew the violation, and dismisses once', async () => {
    const onDismissed = vi.fn();
    render(
      <AppealResultNotice
        result={result(
          'moderation_appeal_accepted',
          'Your appeal about the letter you sent on 20 Oct 2026, 09:00 was accepted. The violation was withdrawn, and your account standing was recalculated.',
        )}
        onDismissed={onDismissed}
      />,
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Your appeal was accepted' });
    expect(dialog.textContent).toMatch(/violation was withdrawn/);
    expect(dialog.textContent).toMatch(/stays in your notifications/);
    expect(dialog.textContent).toMatch(/Decided \d{1,2} Oct 2026, \d{2}:\d{2}/);
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'OK' })));
    expect(api.appealResultSeen).toHaveBeenCalledTimes(1);
    expect(api.appealResultSeen).toHaveBeenCalledWith('ntf_1');
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });

  it('says a rejected appeal is final, and Escape dismisses it too', async () => {
    const onDismissed = vi.fn();
    render(
      <AppealResultNotice
        result={result(
          'moderation_appeal_rejected',
          'Your appeal about the letter you sent on 20 Oct 2026, 09:00 was reviewed and rejected. The decision stands. This is final within SeaYou, and it cannot be appealed again.',
        )}
        onDismissed={onDismissed}
      />,
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Your appeal was rejected' });
    expect(dialog.textContent).toMatch(/final within SeaYou/);
    await act(async () => void fireEvent.keyDown(document, { key: 'Escape' }));
    expect(api.appealResultSeen).toHaveBeenCalledTimes(1);
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });

  it('a stray backdrop tap does not dismiss it', () => {
    const onDismissed = vi.fn();
    render(
      <AppealResultNotice
        result={result('moderation_appeal_rejected', 'Rejected.')}
        onDismissed={onDismissed}
      />,
    );
    fireEvent.click(document.querySelector('.confirm-backdrop')!);
    expect(api.appealResultSeen).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});
