import {
  DEFAULT_LETTER_FONT,
  FriendSchema,
  IdempotencyKeySchema,
  LetterFontSchema,
  type FriendDto,
  type LetterFont,
} from '@mib/shared';
import { z } from 'zod';
import { newIdempotencyKey } from './format.js';

/** The unsent letter, kept for this tab only so a reload does not lose it. */
export interface Draft {
  recipient: FriendDto | null;
  text: string;
  font: LetterFont;
  idempotencyKey: string;
}

export const DRAFT_KEY = 'mib.draft';

// Session storage is writable by anything running in the tab and outlives app versions,
// so a stored draft is data to check, never a value to trust.
const StoredDraftSchema = z.object({
  recipient: FriendSchema.nullable(),
  text: z.string().max(20_000),
  font: LetterFontSchema,
  idempotencyKey: IdempotencyKeySchema,
});

export function emptyDraft(): Draft {
  return {
    recipient: null,
    text: '',
    font: DEFAULT_LETTER_FONT,
    idempotencyKey: newIdempotencyKey(),
  };
}

/** The stored draft, or an empty one when nothing valid is stored. */
export function loadDraft(): Draft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return emptyDraft();
    const parsed = StoredDraftSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* unreadable storage or malformed JSON: start again */
  }
  return emptyDraft();
}

/** Stores the draft; a draft with nothing in it leaves nothing in the browser. */
export function saveDraft(draft: Draft): void {
  if (!draft.recipient && draft.text === '') return clearDraft();
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* storage full or blocked: the draft lives in memory only */
  }
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}
