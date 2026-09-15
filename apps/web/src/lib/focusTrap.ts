const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
  );
}

// Given the focusable elements of a dialog, where Tab should land next; null means "let the
// browser handle it" (focus is inside and not at an edge). Pure so it can be unit-tested.
export function nextTabTarget(
  focusables: HTMLElement[],
  active: Element | null,
  shift: boolean,
): HTMLElement | null {
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!first || !last) return null;
  const inside = active !== null && focusables.includes(active as HTMLElement);
  if (!inside) return shift ? last : first;
  if (!shift && active === last) return first;
  if (shift && active === first) return last;
  return null;
}
