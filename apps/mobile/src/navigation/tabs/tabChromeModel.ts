// Numbers of the tabs' drawn large title (`TabScreenChrome.tsx`), kept pure so
// they are testable without a renderer. They follow UIKit's large title: 34 pt
// text on a 41 pt line, and the small title takes over once the big one has
// scrolled mostly out from under the header.

/** Height of the large title's line. */
export const LARGE_TITLE_LINE_HEIGHT = 41;

/** Scroll distance past which the header shows the small title. */
export const LARGE_TITLE_COLLAPSE_OFFSET = 30;

/** Whether the large title has scrolled away, from the list's offset below its top inset. */
export function largeTitleCollapsed(scrolledPastTop: number): boolean {
  return scrolledPastTop > LARGE_TITLE_COLLAPSE_OFFSET;
}
