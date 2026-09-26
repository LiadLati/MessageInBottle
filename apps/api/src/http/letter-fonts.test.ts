import { describe, expect, it } from 'vitest';
import { LETTER_FONTS, type OpenedLetterDto } from '@mib/shared';
import { createApp } from './app.js';
import { commitArrivalIfDue } from '../services/journey.js';
import { createTestWorld, loginAs, releaseInput } from '../test/harness.js';

// Manual review round 2, item 3: a letter written in any face — the new ones included — keeps
// that face for the sender and for the recipient, however often it is read.

const DAY = 86_400_000;

describe('letter faces survive the whole journey', () => {
  it.each(LETTER_FONTS.slice(4))('%s: sender view and recipient reader', async (font) => {
    const w = createTestWorld({ defaultShoreCapacity: 20 });
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    const bo = await loginAs(app, 'bo');
    const h = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
    const res = await app.request('/api/bottles/release', {
      method: 'POST',
      headers: h(ada.token),
      body: JSON.stringify({ ...releaseInput(bo.id, `font-${font}-000000`), font }),
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { bottle: { id: string } }).bottle.id;
    const own = (await (
      await app.request(`/api/bottles/sent/${id}/letter`, { headers: h(ada.token) })
    ).json()) as OpenedLetterDto;
    expect(own.letter.font).toBe(font);
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, id, w.clock.now());
    const opened = (await (
      await app.request(`/api/shore/bottles/${id}/open`, { method: 'POST', headers: h(bo.token) })
    ).json()) as OpenedLetterDto;
    expect(opened.letter.font).toBe(font);
    // Read again later (a reload): still the same face.
    const again = (await (
      await app.request(`/api/shore/bottles/${id}/letter`, { headers: h(bo.token) })
    ).json()) as OpenedLetterDto;
    expect(again.letter.font).toBe(font);
  });
});
