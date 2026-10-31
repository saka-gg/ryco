/*
 * Behaviour of a horizontal tab strip (the open chat tabs in the chat header): scrolling a tab into
 * view inside its own strip, and mapping a mouse wheel's vertical scroll to sideways scrolling.
 * Ported from Synara's `lib/tabStrip.ts` and `SurfaceTabStrip`.
 */

// Scroll only the strip itself (not `scrollIntoView`, which would also scroll every scrollable
// ancestor such as the chat column when the strip mounts offscreen).
export function scrollTabIntoView(strip: HTMLElement, tab: HTMLElement): void {
  const stripRect = strip.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const left = tabRect.left - stripRect.left + strip.scrollLeft;
  const right = left + tabRect.width;
  if (left < strip.scrollLeft) {
    strip.scrollLeft = left;
  } else if (right > strip.scrollLeft + strip.clientWidth) {
    strip.scrollLeft = right - strip.clientWidth;
  }
}

/** The fields of a `WheelEvent` the wheel mapping reads. */
export interface TabStripWheelSample {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly ctrlKey: boolean;
  readonly timeStamp: number;
}

/** A pause longer than this ends a wheel gesture (WheelEvent has no gesture-end signal). */
export const TAB_STRIP_WHEEL_GESTURE_GAP_MS = 250;

/**
 * Wheel mice only emit vertical deltas; the returned function says how far to scroll the strip
 * sideways for each sample (0: leave it to the browser). Once a gesture carries sideways movement
 * (a trackpad), its remaining samples go to the browser too: a trackpad can briefly emit
 * `deltaX === 0`, and writing `scrollLeft` for that sample fights the native scroll. A quiet gap
 * lets the next vertical-only gesture use the mouse-wheel mapping again. Pinch zoom (ctrl) is
 * never mapped.
 */
export function createTabStripWheelMapping(): (sample: TabStripWheelSample) => number {
  let lastWheelAt = -Infinity;
  let nativeHorizontalGesture = false;
  return (sample) => {
    if (sample.ctrlKey) return 0;
    if (sample.timeStamp - lastWheelAt > TAB_STRIP_WHEEL_GESTURE_GAP_MS) {
      nativeHorizontalGesture = false;
    }
    lastWheelAt = sample.timeStamp;
    if (sample.deltaX !== 0) nativeHorizontalGesture = true;
    if (nativeHorizontalGesture || sample.deltaY === 0) return 0;
    return sample.deltaY;
  };
}
