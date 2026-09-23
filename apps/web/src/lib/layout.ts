// The side-pane layout (map left, sheet right, navigation as a rail): desktop widths, and a
// phone held in landscape. Must match the media query in styles.css.
export const SIDE_PANE_QUERY =
  '(min-width: 900px), (orientation: landscape) and (max-height: 520px) and (min-width: 560px)';

/** True when sheets sit beside the map rather than over its lower part. */
export function sidePaneLayout(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia(SIDE_PANE_QUERY).matches;
}
