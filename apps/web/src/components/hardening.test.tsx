// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationDto, ViolationNoticeDto } from '@mib/shared';
import type * as ClientModule from '../api/client.js';

// Re-audit findings QA-R-003 (no test of the error boundary), FE-R-007, FE-R-009, FE-R-011,
// FE-R-017 and FE-R-018.

const api = vi.hoisted(() => ({
  blockedUsers: vi.fn(),
  presentDecision: vi.fn(),
  notifications: vi.fn(),
}));
vi.mock('../api/client.js', async (actual) => ({
  ...(await actual<typeof ClientModule>()),
  api,
}));

import { ApiError } from '../api/client.js';
import { inertAll } from '../lib/modal.js';
import { describeFailure } from '../screens/LoginScreen.js';
import { NotificationsScreen } from '../screens/NotificationsScreen.js';
import { BlockedUsersDialog } from './BlockedUsersDialog.js';
import { DecisionNotice } from './DecisionNotice.js';
import { DeleteAccountDialog } from './DeleteAccountDialog.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { DeckScreen } from './ui.js';

beforeEach(() => {
  api.presentDecision.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the error boundary (QA-R-003)', () => {
  function Boom({ fail }: { fail: boolean }): React.ReactNode {
    if (fail) throw new Error('chunk failed to load');
    return <p>the part</p>;
  }

  it('shows the fallback instead of blanking, and recovers on retry', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Harness() {
      const [fail, setFail] = useState(true);
      return (
        <>
          <p>the rest of the app</p>
          <ErrorBoundary
            fallback={(reset) => (
              <button
                type="button"
                onClick={() => {
                  setFail(false);
                  reset();
                }}
              >
                Try again
              </button>
            )}
          >
            <Boom fail={fail} />
          </ErrorBoundary>
        </>
      );
    }
    render(<Harness />);
    // The failure is contained: the rest of the app is still on screen.
    expect(screen.getByText('the rest of the app')).toBeTruthy();
    expect(screen.queryByText('the part')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('the part')).toBeTruthy();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('a list that fails to load is not an empty list (FE-R-007)', () => {
  it('Blocked users says it failed and offers Try again', async () => {
    api.blockedUsers.mockRejectedValueOnce(new ApiError(500, 'internal', 'unexpected error'));
    render(<BlockedUsersDialog onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'Try again' });
    expect(screen.queryByText('You have not blocked anyone.')).toBeNull();
    api.blockedUsers.mockResolvedValueOnce({ blocked: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('You have not blocked anyone.');
  });
});

const NOTICE: ViolationNoticeDto = {
  id: 'vio_1',
  ordinal: 3,
  category: 'harassment',
  decidedAt: '2026-09-20T10:00:00.000Z',
  revokedAt: null,
  acknowledgedAt: null,
  severity: 'standard',
  bottle: {
    id: 'btl_1',
    recipientDisplayName: 'Bea',
    releasedAt: '2026-09-18T10:00:00.000Z',
    readByFinder: true,
  },
  appeal: null,
  appealAvailable: true,
  appealWaivedAt: null,
  noticePresentedAt: null,
  appealDeadlineAt: '2026-10-20T10:00:00.000Z',
  appealExpired: false,
  appealReopenedAt: null,
};

describe('the decision notice (FE-R-011, SEC-R-013)', () => {
  it('keeps sign-out and account deletion reachable without answering', () => {
    const onSignOut = vi.fn();
    const onDeleteAccount = vi.fn();
    const onResolved = vi.fn();
    render(
      <DecisionNotice
        notice={NOTICE}
        onResolved={onResolved}
        onSignOut={onSignOut}
        onDeleteAccount={onDeleteAccount}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(onDeleteAccount).toHaveBeenCalledOnce();
    // Neither resolves the notice.
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('says a finder read it, so the intended recipient is not implicated', () => {
    render(<DecisionNotice notice={NOTICE} onResolved={vi.fn()} />);
    expect(screen.getByRole('alertdialog').textContent).toMatch(/lost at sea and read by a finder/);
  });
});

describe('dialog semantics (FE-R-017)', () => {
  it('the delete dialog announces its consequences', () => {
    render(<DeleteAccountDialog onCancel={vi.fn()} onDeleted={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    const description = document.getElementById(dialog.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toMatch(/permanent and cannot be undone/);
  });

  it('a dialog closing over another leaves the page inert until the last one closes', () => {
    const page = document.createElement('div');
    document.body.appendChild(page);
    const releaseOuter = inertAll([page]);
    const releaseInner = inertAll([page]);
    releaseInner();
    expect(page.hasAttribute('inert')).toBe(true);
    releaseInner(); // a second release of the same claim changes nothing
    expect(page.hasAttribute('inert')).toBe(true);
    releaseOuter();
    expect(page.hasAttribute('inert')).toBe(false);
    page.remove();
  });
});

describe('a mangled reset link (FE-R-018)', () => {
  it('reads as an invalid or expired link, not as a form error', () => {
    const tokenInvalid = new ApiError(400, 'validation', 'invalid request body', [
      { path: ['token'], code: 'too_small', message: 'too short' },
    ]);
    expect(describeFailure(tokenInvalid, 'reset')).toMatch(/reset link is invalid or has expired/);
    const passwordInvalid = new ApiError(400, 'validation', 'invalid request body', [
      { path: ['password'], code: 'too_small', message: 'too short' },
    ]);
    expect(describeFailure(passwordInvalid, 'reset')).toMatch(/check the fields/);
    expect(describeFailure(tokenInvalid, 'signin')).toMatch(/check the fields/);
  });
});

const note = (id: string, readAt: string | null = null): NotificationDto =>
  ({
    id,
    kind: 'sent_arrived',
    message: `message ${id}`,
    bottleId: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    readAt,
  }) as NotificationDto;

describe('the notification history (FE-R-009)', () => {
  it('says which entries are unread, in words', () => {
    render(
      <NotificationsScreen
        notifications={[note('a'), note('b', '2026-09-20T11:00:00.000Z')]}
        nextCursor={null}
        loading={false}
        error={null}
        onBack={vi.fn()}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.textContent).toMatch(/^Unread\./);
    expect(items[1]!.textContent).not.toMatch(/Unread/);
  });

  it('keeps entries that slide off the first page after an older page was loaded', async () => {
    // First page: n5..n4, older page: n3..n1. Then two new notices arrive on the polled page,
    // pushing n5 and n4 off it: they must stay listed between the new page and the older one.
    api.notifications.mockResolvedValueOnce({
      notifications: [note('n3'), note('n2'), note('n1')],
      nextCursor: null,
      unreadCount: 0,
    });
    const props = { nextCursor: 'c1', loading: false, error: null, onBack: vi.fn() };
    const { rerender } = render(
      <NotificationsScreen notifications={[note('n5'), note('n4')]} {...props} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load older notifications' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
    rerender(<NotificationsScreen notifications={[note('n7'), note('n6')]} {...props} />);
    const ids = screen.getAllByRole('listitem').map((li) => li.textContent?.match(/n\d/)?.[0]);
    expect(ids).toEqual(['n7', 'n6', 'n5', 'n4', 'n3', 'n2', 'n1']);
  });
});

describe('focus on in-place view changes (FE-R-006)', () => {
  it('moves to the new heading when the view changes, not on first render', () => {
    const { rerender } = render(
      <>
        <button type="button">Next</button>
        <DeckScreen title="Who is this for?" view="friend">
          <p>list</p>
        </DeckScreen>
      </>,
    );
    const next = screen.getByRole('button', { name: 'Next' });
    next.focus();
    expect(document.activeElement).toBe(next);
    rerender(
      <>
        <button type="button">Next</button>
        <DeckScreen title="A letter to Bea" view="compose">
          <p>compose</p>
        </DeckScreen>
      </>,
    );
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'A letter to Bea' }));
  });

  it('a view opened as its own screen can take focus on mount', () => {
    render(
      <DeckScreen title="Report" focusOnMount>
        <p>case</p>
      </DeckScreen>,
    );
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Report' }));
  });
});
