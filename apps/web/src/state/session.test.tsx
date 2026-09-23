// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client.js';
import { SESSION_ENDED_NOTICE, SessionProvider, useSession } from './session.js';

// Behavioural tests of what the Privacy Policy promises about this browser, replacing checks
// that only searched the source text (audit QA-008).

const ME = {
  id: 'usr_a',
  username: 'ada',
  displayName: 'Ada',
  shoreId: null,
  email: null,
  timeZone: null,
  role: 'member',
  policies: { status: 'released', required: false, documents: [] },
};

function reply(status: number, body: unknown) {
  return Promise.resolve(
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function Probe() {
  const s = useSession();
  return (
    <div>
      <span data-testid="user">{s.user?.username ?? 'none'}</span>
      <span data-testid="loading">{String(s.loading)}</span>
      <span data-testid="reconnecting">{String(s.reconnecting)}</span>
      <span data-testid="notice">{s.endedNotice ?? ''}</span>
      <button onClick={() => void s.logout()}>sign out</button>
      <button onClick={() => void api.chart().catch(() => {})}>load chart</button>
    </div>
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('signing out clears this browser (Privacy Policy §5; FE-010, QA-008)', () => {
  it('removes the session token, the unsent letter and the stored time zone', async () => {
    sessionStorage.setItem('mib.session.token', 'tok');
    sessionStorage.setItem('mib.draft', JSON.stringify({ text: 'Dear…' }));
    localStorage.setItem('mib.accountTimeZone', 'Europe/Berlin');
    vi.stubGlobal('fetch', (url: string) =>
      url.endsWith('/auth/me') ? reply(200, ME) : reply(204, null),
    );
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('ada'));
    act(() => screen.getByText('sign out').click());
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('none'));
    expect(screen.getByTestId('user').textContent).toBe('none');
    expect(sessionStorage.getItem('mib.session.token')).toBeNull();
    expect(sessionStorage.getItem('mib.draft')).toBeNull();
    expect(localStorage.getItem('mib.accountTimeZone')).toBeNull();
    // Signing out yourself is not "your session ended".
    expect(screen.getByTestId('notice').textContent).toBe('');
  });
});

describe('an ended session returns to sign-in (FE-002)', () => {
  it('drops to signed out with an explanation when the server rejects the token', async () => {
    sessionStorage.setItem('mib.session.token', 'tok');
    sessionStorage.setItem('mib.draft', 'x');
    let revoked = false;
    vi.stubGlobal('fetch', (url: string) => {
      if (url.endsWith('/auth/me')) return reply(200, ME);
      if (revoked)
        return reply(401, { error: { code: 'unauthorized', message: 'authentication required' } });
      return reply(200, { shores: [] });
    });
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('ada'));
    revoked = true;
    act(() => screen.getByText('load chart').click());
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('none'));
    expect(screen.getByTestId('notice').textContent).toBe(SESSION_ENDED_NOTICE);
    expect(sessionStorage.getItem('mib.session.token')).toBeNull();
    expect(sessionStorage.getItem('mib.draft')).toBeNull();
  });
});

describe('an unreachable server does not sign anyone out (FE-003)', () => {
  it('keeps the stored token and retries until the server answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sessionStorage.setItem('mib.session.token', 'tok');
    let up = false;
    vi.stubGlobal('fetch', () =>
      up ? reply(200, ME) : Promise.reject(new TypeError('Failed to fetch')),
    );
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('reconnecting').textContent).toBe('true'));
    expect(sessionStorage.getItem('mib.session.token')).toBe('tok');
    expect(screen.getByTestId('loading').textContent).toBe('true');
    up = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('ada'));
    expect(screen.getByTestId('reconnecting').textContent).toBe('false');
  });
});
