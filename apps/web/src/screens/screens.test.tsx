// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountStandingDto } from '@mib/shared';
import type * as ClientModule from '../api/client.js';

// What restricted and destructive screens actually render (audit QA-003, FE-016, FE-019).

const api = vi.hoisted(() => ({
  friends: vi.fn(),
  blockUser: vi.fn(),
}));
vi.mock('../api/client.js', async (actual) => ({
  ...(await actual<typeof ClientModule>()),
  api,
}));
const logout = vi.hoisted(() => vi.fn());
vi.mock('../state/session.js', () => ({ useSession: () => ({ logout }) }));

import { FriendsScreen } from './FriendsScreen.js';
import { StandingScreen } from './StandingScreen.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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
      /you can read this page, appeal, get support, delete the\s+account and sign out/,
    );
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
    expect(dialog.textContent).toMatch(/cannot be undone/);
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
