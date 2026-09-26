import { describe, expect, it } from 'vitest';
import { DIRECTION_CONTROLS_MESSAGE } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { createTestWorld, loginAs, releaseInput } from '../test/harness.js';

// Product decision 11, server side (authoritative): a letter with invisible direction controls
// is refused with a clear message, nothing is created, and ordinary right-to-left text passes.

async function release(text: string) {
  const w = createTestWorld({ defaultShoreCapacity: 40 });
  const app = createApp(w.ctx);
  const ada = await loginAs(app, 'ada');
  const res = await app.request('/api/bottles/release', {
    method: 'POST',
    headers: { authorization: `Bearer ${ada.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...releaseInput(w.user('bo').id, 'controls-000001'), text }),
  });
  return { w, res };
}

describe('direction controls in a released letter (product decision 11)', () => {
  it('refuses the letter with a message asking to remove them, creating nothing', async () => {
    const rlo = String.fromCodePoint(0x202e);
    const { w, res } = await release(`Meet me at gate ${rlo}21 tonight`);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: {
        message: DIRECTION_CONTROLS_MESSAGE,
        details: { rejection: 'letter_direction_controls' },
      },
    });
    expect(w.db.select().from(t.bottles).all()).toEqual([]);
    expect(w.db.select().from(t.letters).all()).toEqual([]);
  });

  it('stores ordinary Hebrew, Arabic and English text exactly as written', async () => {
    const text = 'שלום! مرحبا! Hello — נתראה ב־10:30.';
    const { w, res } = await release(text);
    expect(res.status).toBe(201);
    expect(w.db.select().from(t.letters).get()!.text).toBe(text);
  });
});
