import { useCallback, useRef } from 'react';

// A system strip (development bar, arrival banner) pinned to the top of the viewport reports its
// height into a CSS custom property on the root element. `--header-pad-top` adds every slot, so
// headers, map controls, sheets and deck content move down and are never covered.
export function useTopSlot(name: 'dev' | 'banner', gap = 0) {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback(
    (el: HTMLElement | null) => {
      const root = document.documentElement;
      const prop = `--slot-${name}`;
      observer.current?.disconnect();
      observer.current = null;
      if (!el) {
        root.style.removeProperty(prop);
        return;
      }
      const apply = () => root.style.setProperty(prop, `${el.offsetHeight + gap}px`);
      apply();
      if (typeof ResizeObserver !== 'undefined') {
        observer.current = new ResizeObserver(apply);
        observer.current.observe(el);
      }
    },
    [name, gap],
  );
}
