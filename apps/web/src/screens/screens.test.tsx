// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountStandingDto, ViolationNoticeDto } from '@mib/shared';
import type * as ClientModule from '../api/client.js';

// What restricted and destructive screens actually render (audit QA-003, FE-016, FE-019).

const api = vi.hoisted(() => ({
  friends: vi.fn(),
  blockUser: vi.fn(),
  blockedUsers: vi.fn(),
  unblockUser: vi.fn(),
}));
vi.mock('../api/client.js', async (actual) => ({
  ...(await actual<typeof ClientModule>()),
  api,
}));
const logout = vi.hoisted(() => vi.fn());
vi.mock('../state/session.js', () => ({ useSession: () => ({ logout }) }));

import { BlockedUsersDialog } from '../components/BlockedUsersDialog.js';
import { FriendsScreen } from './FriendsScreen.js';
import { StandingScreen } from './StandingScreen.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const VIOLATION: ViolationNoticeDto = {
  id: 'vio_1',
  ordinal: 2,
  category: 'harassment',
  decidedAt: '2026-09-23T00:00:00.000Z',
  revokedAt: null,
  acknowledgedAt: null,
  severity: 'standard',
  bottle: { id: 'btl_1', recipientDisplayName: 'Bea', releasedAt: '2026-09-20T10:00:00.000Z' },
  appeal: null,
  appealAvailable: true,
  appealWaivedAt: null,
  noticePresentedAt: '2026-09-23T00:00:00.000Z',
  appealDeadlineAt: '2026-10-23T00:00:00.000Z',
  appealExpired: false,
  appealReopenedAt: null,
};

const SUSPENDED: AccountStandingDto = {
  standing: 'suspended',
  suspendedUntil: '2026-09-30T00:00:00.000Z',
  violationsInForce: 2,
  pendingWarning: null,
  pendingDecision: null,
  violations: [],
};

describe('a suspended account (FE-019)', () => {
  it('offers exactly what the Terms promise: support, deletion, sign-out', () => {
    const onDelete = vi.fn();
    render(<StandingScreen standing={SUSPENDED} onDeleteAccount={onDelete} />);
    expect(screen.getByRole('link', { name: 'Help & Support' }).getAttribute('href')).toBe(
      '/support',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
    expect(onDelete).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalled();
    expect(document.body.textContent).toMatch(
      /you can read this page, appeal a decision within its\s+30-day appeal period, get support, delete the account and sign out/,
    );
  });

  it('shows the reason, the end time, a live countdown and the ban warning', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-09-29T21:30:00.000Z'));
    render(<StandingScreen standing={{ ...SUSPENDED, violations: [VIOLATION] }} />);
    expect(document.body.textContent).toMatch(/most recently for harassment/);
    expect(screen.getByRole('timer').textContent).toBe('2h 30m left');
    act(() => {
      vi.advanceTimersByTime(60 * 60_000);
    });
    expect(screen.getByRole('timer').textContent).toBe('1h 30m left');
    expect(document.body.textContent).toMatch(/Another upheld violation means a permanent ban/);
    expect(document.body.textContent).toMatch(/opens again automatically/);
  });

  it('asks the server again once the suspension has run out', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-09-29T23:59:58.000Z'));
    const onEnded = vi.fn();
    render(<StandingScreen standing={SUSPENDED} onSuspensionEnded={onEnded} />);
    expect(onEnded).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(onEnded).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(onEnded).toHaveBeenCalledTimes(1);
  });
});

describe('a banned account', () => {
  it('has the same shell with no countdown, and says when the ban was a critical violation', () => {
    render(
      <StandingScreen
        standing={{
          ...SUSPENDED,
          standing: 'banned',
          suspendedUntil: null,
          violations: [{ ...VIOLATION, severity: 'critical' }],
        }}
        onDeleteAccount={vi.fn()}
      />,
    );
    expect(screen.queryByRole('timer')).toBeNull();
    expect(document.body.textContent).toMatch(/critical child-safety\s+violation/);
    expect(document.body.textContent).toMatch(/permanently banned/);
    expect(screen.getByRole('button', { name: 'Delete account' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(document.body.textContent).toMatch(/Appeal open until/);
  });
});

describe('Settings → Blocked users', () => {
  it('lists blocked accounts and unblocks only after the confirmation', async () => {
    api.blockedUsers.mockResolvedValueOnce({
      blocked: [
        {
          username: 'bea',
          displayName: 'Bea',
          blockedAt: '2026-09-01T10:00:00.000Z',
          foundBottleId: null,
        },
      ],
    });
    api.blockedUsers.mockResolvedValue({ blocked: [] });
    api.unblockUser.mockResolvedValue(undefined);
    render(<BlockedUsersDialog onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unblock Bea' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toMatch(/does not bring anything back/);
    expect(dialog.textContent).toMatch(/not friends again/);
    expect(api.unblockUser).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.unblockUser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Bea' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Unblock' }),
    );
    await waitFor(() => expect(api.unblockUser).toHaveBeenCalledWith('bea'));
    expect((await screen.findByRole('status')).textContent).toBe('Bea unblocked');
    expect(await screen.findByText('You have not blocked anyone.')).toBeTruthy();
  });
});

describe('blocking a friend (FE-016)', () => {
  const BEA = { id: 'usr_b', username: 'bea', displayName: 'Bea', hasShore: true };
  const load = () => {
    api.friends.mockResolvedValue({
      friends: [BEA],
      incomingRequests: [],
      outgoingRequests: [],
      pendingIncomingCount: 0,
    });
    render(<FriendsScreen />);
  };

  it('asks in a real dialog, and Cancel blocks nobody', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    load();
    fireEvent.click(await screen.findByRole('button', { name: 'Block' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toMatch(/unblock them later from Settings/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.blockUser).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('blocks on confirmation and says so', async () => {
    api.blockUser.mockResolvedValue(undefined);
    load();
    fireEvent.click(await screen.findByRole('button', { name: 'Block' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Block' }));
    await waitFor(() => expect(api.blockUser).toHaveBeenCalledWith('bea'));
    expect((await screen.findByRole('status')).textContent).toBe('Bea blocked');
  });
});
