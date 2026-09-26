// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { DRAFT_KEY, clearDraft, loadDraft, saveDraft } from './draft.js';

// A stored draft is untrusted input (audit QA-007): valid JSON of the wrong shape must not
// reach the screen, and it must not be left behind to fail again on the next load.

const good = {
  recipient: { id: 'usr_b', username: 'bea', displayName: 'Bea', hasShore: true },
  text: 'Dear Bea,',
  font: 'typewriter',
  idempotencyKey: 'key-12345678',
};

beforeEach(() => sessionStorage.clear());

describe('the stored draft', () => {
  it('round-trips a valid draft', () => {
    saveDraft(good as Parameters<typeof saveDraft>[0]);
    expect(loadDraft()).toEqual(good);
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['a string', JSON.stringify('hello')],
    ['text that is not a string', JSON.stringify({ ...good, text: 42 })],
    ['an unknown font', JSON.stringify({ ...good, font: 'comic-sans' })],
    ['a recipient without an id', JSON.stringify({ ...good, recipient: { username: 'x' } })],
    ['a missing idempotency key', JSON.stringify({ ...good, idempotencyKey: undefined })],
  ])('starts a fresh draft instead of trusting %s', (_label, raw) => {
    sessionStorage.setItem(DRAFT_KEY, raw);
    const draft = loadDraft();
    expect(draft.text).toBe('');
    expect(draft.recipient).toBeNull();
    expect(draft.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  });

  it('drops a stored draft that fails validation', () => {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...good, font: 'nope' }));
    loadDraft();
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('is gone after clearDraft', () => {
    saveDraft(good as Parameters<typeof saveDraft>[0]);
    clearDraft();
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('stores nothing for an empty draft', () => {
    saveDraft(good as Parameters<typeof saveDraft>[0]);
    saveDraft({ ...(good as Parameters<typeof saveDraft>[0]), recipient: null, text: '' });
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('gives every fresh draft its own idempotency key', () => {
    expect(loadDraft().idempotencyKey).not.toBe(loadDraft().idempotencyKey);
  });
});
