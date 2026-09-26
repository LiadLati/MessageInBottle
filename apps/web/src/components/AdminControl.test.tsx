// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminControl } from './AdminControl.js';

// The moderation badge on the admin control (manual review round 1, item 3): the count of
// undecided reports and appeals the administrator can act on, styled like the notification
// badge, with each kind counted in the menu so reports and appeals stay distinguishable.

afterEach(cleanup);

describe('the moderation badge', () => {
  it('shows nothing when no work is waiting', () => {
    render(<AdminControl onOpen={vi.fn()} pending={{ reports: 0, appeals: 0, total: 0 }} />);
    const trigger = screen.getByRole('button', { name: 'Admin' });
    expect(trigger.querySelector('.inbox-count')).toBeNull();
  });

  it('counts waiting reports and appeals, and says which is which', () => {
    const onOpen = vi.fn();
    render(<AdminControl onOpen={onOpen} pending={{ reports: 2, appeals: 1, total: 3 }} />);
    const trigger = screen.getByRole('button', {
      name: 'Admin, 2 reports and 1 appeals waiting',
    });
    expect(trigger.querySelector('.inbox-count')?.textContent).toBe('3');
    fireEvent.click(trigger);
    const reports = screen.getByRole('menuitem', { name: /Reports/ });
    const appeals = screen.getByRole('menuitem', { name: /Appeals/ });
    expect(reports.textContent).toMatch(/2 waiting/);
    expect(appeals.textContent).toMatch(/1 waiting/);
    fireEvent.click(appeals);
    expect(onOpen).toHaveBeenCalledWith('appeals');
  });

  it('caps a large count at 9+', () => {
    render(<AdminControl onOpen={vi.fn()} pending={{ reports: 12, appeals: 0, total: 12 }} />);
    expect(document.querySelector('.inbox-count')?.textContent).toBe('9+');
  });
});
