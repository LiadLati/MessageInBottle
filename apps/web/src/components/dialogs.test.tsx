// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPEAL_ACTION_APPEAL,
  APPEAL_ACTION_CONTINUE,
  APPEAL_ACTION_SKIP,
  APPEAL_WAIVER_CONFIRMATION,
  type ViolationNoticeDto,
} from '@mib/shared';
import type * as ClientModule from '../api/client.js';
import { useModalKeys } from '../lib/modal.js';

// Rendering tests for the dialogs whose mistakes cost the most (audit QA-003): the decision
// notice a sanctioned person must answer, account deletion, the consent controls, and the
// keyboard behaviour every modal shares (A11Y-004, A11Y-005, A11Y-006).

const api = vi.hoisted(() => ({
  presentDecision: vi.fn(),
  waiveAppeal: vi.fn(),
  submitAppeal: vi.fn(),
  acknowledgeWarning: vi.fn(),
  deleteAccount: vi.fn(),
}));
vi.mock('../api/client.js', async (actual) => ({
  ...(await actual<typeof ClientModule>()),
  api,
}));

import { ApiError } from '../api/client.js';
import { DecisionNotice } from './DecisionNotice.js';
import { DeleteAccountDialog } from './DeleteAccountDialog.js';
import { EMPTY_CONSENT, PolicyConsent, type ConsentState } from './PolicyConsent.js';
import { TabList, tabPanelProps } from './Tabs.js';

const NOTICE: ViolationNoticeDto = {
  id: 'vio_1',
  ordinal: 1,
  category: 'harassment',
  decidedAt: '2026-09-20T10:00:00.000Z',
  revokedAt: null,
  acknowledgedAt: null,
  severity: 'standard',
  bottle: { id: 'btl_1', recipientDisplayName: 'Bea', releasedAt: '2026-09-18T10:00:00.000Z' },
  appeal: null,
  appealAvailable: true,
  appealWaivedAt: null,
  noticePresentedAt: null,
  appealDeadlineAt: '2026-10-20T10:00:00.000Z',
  appealExpired: false,
  appealReopenedAt: null,
};

beforeEach(() => {
  api.presentDecision.mockResolvedValue({});
  api.waiveAppeal.mockResolvedValue({});
  api.submitAppeal.mockResolvedValue({});
  api.acknowledgeWarning.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the decision notice', () => {
  it('announces the decision itself, not only its title', () => {
    render(<DecisionNotice notice={NOTICE} onResolved={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog');
    const body = document.getElementById(dialog.getAttribute('aria-describedby')!);
    expect(body?.textContent).toMatch(/reported for\s+harassment/);
    expect(body?.textContent).toMatch(/This is a warning/);
    expect(body?.textContent).toMatch(/appeal this decision once/);
    expect(api.presentDecision).toHaveBeenCalledWith('vio_1');
  });

  it('cannot be dismissed with Escape, even with focus on the page body', () => {
    const onResolved = vi.fn();
    render(<DecisionNotice notice={NOTICE} onResolved={onResolved} />);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('waives the appeal only after the explicit confirmation', async () => {
    const onResolved = vi.fn();
    render(<DecisionNotice notice={NOTICE} onResolved={onResolved} />);
    fireEvent.click(screen.getByRole('button', { name: APPEAL_ACTION_CONTINUE }));
    expect(api.waiveAppeal).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe(
      APPEAL_WAIVER_CONFIRMATION,
    );
    fireEvent.click(screen.getByRole('button', { name: APPEAL_ACTION_SKIP }));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(api.waiveAppeal).toHaveBeenCalledWith('vio_1');
  });

  it('sends one appeal with the trimmed text, and not an empty one', async () => {
    const onResolved = vi.fn();
    render(<DecisionNotice notice={NOTICE} onResolved={onResolved} />);
    fireEvent.click(screen.getByRole('button', { name: APPEAL_ACTION_APPEAL }));
    const send = screen.getByRole('button', { name: 'Send appeal' });
    expect(send).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  It was a quote.  ' } });
    fireEvent.click(send);
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(api.submitAppeal).toHaveBeenCalledWith('vio_1', 'It was a quote.');
  });

  it('keeps the person on the notice when the server refuses', async () => {
    api.waiveAppeal.mockRejectedValue(new Error('offline'));
    const onResolved = vi.fn();
    render(<DecisionNotice notice={NOTICE} onResolved={onResolved} />);
    fireEvent.click(screen.getByRole('button', { name: APPEAL_ACTION_CONTINUE }));
    fireEvent.click(screen.getByRole('button', { name: APPEAL_ACTION_SKIP }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('states the appeal deadline while the appeal is open', () => {
    render(<DecisionNotice notice={NOTICE} onResolved={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog');
    const body = document.getElementById(dialog.getAttribute('aria-describedby')!);
    expect(body?.textContent).toMatch(/appeal this decision once, until .*2026/);
  });

  it('after the deadline shows the decision as final, with no appeal and no waiver', async () => {
    const onResolved = vi.fn();
    render(
      <DecisionNotice
        notice={{ ...NOTICE, appealAvailable: false, appealExpired: true }}
        onResolved={onResolved}
      />,
    );
    const dialog = screen.getByRole('alertdialog');
    const body = document.getElementById(dialog.getAttribute('aria-describedby')!);
    expect(body?.textContent).toMatch(/appeal period for this decision expired on/);
    expect(body?.textContent).toMatch(/The decision is final/);
    expect(screen.queryByRole('button', { name: APPEAL_ACTION_APPEAL })).toBeNull();
    expect(screen.queryByRole('button', { name: APPEAL_ACTION_CONTINUE })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'I understand' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(api.acknowledgeWarning).toHaveBeenCalledWith('vio_1');
  });

  it('says a reclassified decision carries a new appeal opportunity', () => {
    render(
      <DecisionNotice
        notice={{
          ...NOTICE,
          severity: 'critical',
          appealReopenedAt: '2026-09-22T10:00:00.000Z',
        }}
        onResolved={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('alertdialog');
    const body = document.getElementById(dialog.getAttribute('aria-describedby')!);
    expect(body?.textContent).toMatch(/permanently banned/);
    expect(body?.textContent).toMatch(/new opportunity to appeal/);
    expect(screen.getByRole('button', { name: APPEAL_ACTION_APPEAL })).toBeTruthy();
  });
});

describe('deleting the account', () => {
  const setup = () => {
    const onCancel = vi.fn();
    const onDeleted = vi.fn();
    render(<DeleteAccountDialog onCancel={onCancel} onDeleted={onDeleted} />);
    return { onCancel, onDeleted, go: screen.getByRole('button', { name: 'Delete permanently' }) };
  };

  it('needs both the password and the explicit acknowledgement', () => {
    const { go } = setup();
    expect(go).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Confirm your password'), { target: { value: 'pw' } });
    expect(go).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(go).toHaveProperty('disabled', false);
  });

  it('says so when the password is wrong, and deletes nothing', async () => {
    api.deleteAccount.mockRejectedValue(new ApiError(401, 'invalid_password', 'no'));
    const { go, onDeleted } = setup();
    fireEvent.change(screen.getByLabelText('Confirm your password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(go);
    expect((await screen.findByRole('alert')).textContent).toBe('That password is not correct.');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('deletes with the typed password', async () => {
    api.deleteAccount.mockResolvedValue({});
    const { go, onDeleted } = setup();
    fireEvent.change(screen.getByLabelText('Confirm your password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(go);
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(api.deleteAccount).toHaveBeenCalledWith('pw');
  });

  it('closes on Escape even after focus has fallen to the page body (A11Y-005)', () => {
    const { onCancel } = setup();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('the consent controls', () => {
  function Harness({ onOpen }: { onOpen: (id: string) => void }) {
    const [value, setValue] = useState<ConsentState>(EMPTY_CONSENT);
    return (
      <>
        <PolicyConsent
          value={value}
          onChange={setValue}
          onOpen={onOpen}
          showProblems
          disabled={false}
        />
        <output data-testid="state">{JSON.stringify(value)}</output>
      </>
    );
  }

  it('starts unchecked, states what is missing, and records each decision separately', () => {
    render(<Harness onOpen={vi.fn()} />);
    const [terms, privacy] = screen.getAllByRole('checkbox');
    expect(terms).toHaveProperty('checked', false);
    expect(privacy).toHaveProperty('checked', false);
    expect(document.body.textContent).toMatch(/accept the Terms of Use and Community Rules/);
    fireEvent.click(terms!);
    expect(screen.getByTestId('state').textContent).toBe('{"terms":true,"privacy":false}');
    fireEvent.click(privacy!);
    expect(screen.getByTestId('state').textContent).toBe('{"terms":true,"privacy":true}');
  });

  it('opens a document from its link without ticking the box', () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    fireEvent.click(screen.getAllByRole('button')[0]!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('state').textContent).toBe(JSON.stringify(EMPTY_CONSENT));
  });
});

describe('tabs (A11Y-006)', () => {
  function Harness() {
    const [tab, setTab] = useState<'a' | 'b' | 'c'>('a');
    return (
      <>
        <TabList
          base="t"
          label="Folders"
          items={['a', 'b', 'c'] as const}
          selected={tab}
          onSelect={setTab}
          labelOf={(x) => x.toUpperCase()}
        />
        <div {...tabPanelProps('t', tab)}>panel {tab}</div>
      </>
    );
  }

  it('has one tab stop, moves with the arrow keys, and points at a panel that exists', () => {
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[1]);
    expect(screen.getAllByRole('tab').map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(tabs[1]!, { key: 'End' });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[0]);
    for (const t of screen.getAllByRole('tab'))
      expect(document.getElementById(t.getAttribute('aria-controls')!)).not.toBeNull();
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[0]!.id);
  });
});

describe('stacked modals', () => {
  function Modal({ name, onEscape }: { name: string; onEscape: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    useModalKeys(ref, onEscape);
    return (
      <div ref={ref} role="dialog" aria-label={name}>
        <button>{name} first</button>
        <button>{name} last</button>
      </div>
    );
  }

  it('lets only the topmost answer Escape, and traps Tab inside it', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const { rerender } = render(
      <>
        <Modal name="letter" onEscape={outer} />
        <Modal name="confirm" onEscape={inner} />
      </>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    // Tab from outside the top dialog lands inside it.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement?.textContent).toBe('confirm first');
    rerender(<Modal name="letter" onEscape={outer} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(outer).toHaveBeenCalledTimes(1);
  });
});
