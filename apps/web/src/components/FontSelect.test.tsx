// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FONT_DEFINITIONS, LETTER_FONTS } from '@mib/shared';
import { FontSelect } from './FontSelect.js';

// Manual review round 2, items 3 and 6: eight faces, each shown by its own name drawn in that
// face, with no repeated sample sentence.

// jsdom has no layout: scrolling the active option into view is a no-op here.
Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);
const options = LETTER_FONTS.map((f) => FONT_DEFINITIONS[f]);

describe('the font picker', () => {
  it('lists every face by name, in that face, with no sample sentence', () => {
    render(<FontSelect label="Font" options={options} value="handwriting" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Font/ }));
    const items = screen.getAllByRole('option');
    expect(items.map((o) => o.textContent)).toEqual(options.map((o) => o.label));
    expect(document.body.textContent).not.toMatch(/Dear friend|the tide was gentle/);
    for (const [i, item] of items.entries())
      // The browser normalises quotes; compare the first family name.
      expect((item.querySelector('span') as HTMLElement).style.fontFamily.split(',')[0]).toBe(
        options[i]!.cssFamily.split(',')[0]!.replace(/'/g, '"'),
      );
    // The selected state is still marked, and keyboard choice still works.
    expect(items[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('chooses a new face by keyboard', () => {
    const onChange = vi.fn();
    render(<FontSelect label="Font" options={options} value="handwriting" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /Font/ }), { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'End' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('rounded');
  });

  it('loads every face from the app’s own bundle', () => {
    const src = readFileSync(join(__dirname, 'LetterPaper.tsx'), 'utf8');
    for (const pkg of ['dancing-script', 'patrick-hand', 'libre-baskerville', 'nunito'])
      expect(src).toContain(`import('@fontsource/${pkg}/400.css')`);
  });
});
