// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClientModule from '../api/client.js';
import { DRAFT_KEY } from '../lib/draft.js';

// The unsent letter is the one thing a user can lose here. These drive the real screen:
// the draft survives a reload, survives a failed release byte for byte, and is removed
// from the browser once the sea confirms the bottle (Privacy Policy §5; QA-003, QA-008).

const api = vi.hoisted(() => ({
  friends: vi.fn(),
  chart: vi.fn(),
  previewRelease: vi.fn(),
  release: vi.fn(),
}));
vi.mock('../api/client.js', async (actual) => ({
  ...(await actual<typeof ClientModule>()),
  api,
}));
vi.mock('../state/session.js', () => ({
  useSession: () => ({ user: { id: 'usr_a', displayName: 'Ada', shoreId: 'shr_a' } }),
}));
// The heavy map and 3D chunks are out of scope; the stand-in finishes the sequence the way
// the real one does, by reporting commit or failure.
vi.mock('../components/lazy.js', () => ({
  OceanMap: () => null,
  ReleaseSequence: ({
    status,
    onFinished,
    onFailed,
  }: {
    status: string;
    onFinished: () => void;
    onFailed: () => void;
  }) => (
    <div>
      <span data-testid="release-status">{status}</span>
      <button onClick={status === 'failed' ? onFailed : onFinished}>end sequence</button>
    </div>
  ),
}));

import { WriteScreen } from './WriteScreen.js';

const BEA = { id: 'usr_b', username: 'bea', displayName: 'Bea', hasShore: true };
const PREVIEW = {
  eligible: true,
  rejection: null,
  originShore: null,
  destinationShore: null,
  route: null,
};

function mount(onReleased = vi.fn()) {
  render(<WriteScreen onReleased={onReleased} onChooseShore={vi.fn()} onImmersive={vi.fn()} />);
  return onReleased;
}

async function composeTo(text: string) {
  fireEvent.click(await screen.findByRole('button', { name: /Bea/ }));
  fireEvent.change(screen.getByLabelText('Your letter'), { target: { value: text } });
}

async function throwIt() {
  fireEvent.click(screen.getByRole('button', { name: 'Seal the letter' }));
  fireEvent.click(await screen.findByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: /Seal and throw/ }));
}

beforeEach(() => {
  sessionStorage.clear();
  api.friends.mockResolvedValue({ friends: [BEA] });
  api.chart.mockResolvedValue({});
  api.previewRelease.mockResolvedValue(PREVIEW);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the unsent letter', () => {
  it('is restored after a reload', async () => {
    mount();
    await composeTo('Dear Bea, the tide is kind today.');
    cleanup(); // the tab reloads
    mount();
    // A restored draft starts at the recipient list; choosing Bea again shows the letter.
    fireEvent.click(await screen.findByRole('button', { name: /Bea/ }));
    expect(screen.getByLabelText('Your letter')).toHaveProperty(
      'value',
      'Dear Bea, the tide is kind today.',
    );
  });

  it('is kept exactly, with the same idempotency key, when the release fails', async () => {
    api.release.mockRejectedValue(new Error('offline'));
    mount();
    await composeTo('Keep me.');
    const before = sessionStorage.getItem(DRAFT_KEY);
    await throwIt();
    await waitFor(() => expect(screen.getByTestId('release-status').textContent).toBe('failed'));
    fireEvent.click(screen.getByRole('button', { name: 'end sequence' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Your letter is intact') as string,
    );
    expect(sessionStorage.getItem(DRAFT_KEY)).toBe(before);
    expect(JSON.parse(before!)).toMatchObject({ text: 'Keep me.' });
  });

  it('is removed from the browser once the sea confirms it', async () => {
    const bottle = { id: 'btl_1' };
    api.release.mockResolvedValue({ bottle });
    const onReleased = mount();
    await composeTo('Goodbye, draft.');
    await throwIt();
    await waitFor(() => expect(screen.getByTestId('release-status').textContent).toBe('committed'));
    fireEvent.click(screen.getByRole('button', { name: 'end sequence' }));
    expect(onReleased).toHaveBeenCalledWith(bottle);
    await waitFor(() => expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull());
    expect(api.release).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 'usr_b', text: 'Goodbye, draft.' }),
    );
  });
});
