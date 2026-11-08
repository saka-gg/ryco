/**
 * Geometry of a thread row's swipe actions: how wide the revealed actions are,
 * where a full swipe arms, and when each action button fades in. The numbers
 * are the upstream phone app's, tuned there on device.
 */
export const SWIPE_ACTION_ITEM_WIDTH = 58;
export const SWIPE_ACTION_CIRCLE_SIZE = 36;
export const SWIPE_ACTION_ICON_SIZE = 15;
/** Extra drag past the revealed actions before a full swipe can arm. */
const FULL_SWIPE_MIN_OVERSHOOT = 44;
/** A full swipe arms once the row moved this share of its width. */
const FULL_SWIPE_WIDTH_SHARE = 0.58;
/** The row opens to its actions once dragged this share of their width. */
export const SWIPE_OPEN_THRESHOLD_SHARE = 0.42;

/** The swipe settles quickly without bouncing (passed to the row's spring). */
export const THREAD_SWIPE_SPRING = {
  damping: 26,
  mass: 0.7,
  overshootClamping: true,
  stiffness: 330,
} as const;

export function swipeActionsWidth(actionCount: number): number {
  return SWIPE_ACTION_ITEM_WIDTH * actionCount;
}

/** How far the row must move before releasing it runs the full-swipe action. */
export function fullSwipeThreshold(actionCount: number, rowWidth: number): number {
  return Math.max(
    swipeActionsWidth(actionCount) + FULL_SWIPE_MIN_OVERSHOOT,
    rowWidth * FULL_SWIPE_WIDTH_SHARE,
  );
}

/**
 * The reveal distance over which one button fades and scales in. With two
 * actions the outer one leads and the inner one follows; a lone action
 * starts almost at once.
 */
export function swipeActionEntryRange(
  position: "inner" | "outer",
  actionCount: number,
): readonly [number, number] {
  if (actionCount < 2 || position === "outer") return [8, SWIPE_ACTION_ITEM_WIDTH * 0.72];
  return [SWIPE_ACTION_ITEM_WIDTH * 0.55, swipeActionsWidth(2) * 0.85];
}

export type SwipeSide = "leading" | "trailing";

/** Which side, if any, is past its full-swipe threshold for a row translation. */
export function armedSwipeSide(
  translation: number,
  thresholds: { readonly leading: number | null; readonly trailing: number | null },
): SwipeSide | null {
  "worklet";
  if (thresholds.trailing !== null && -translation >= thresholds.trailing) return "trailing";
  if (thresholds.leading !== null && translation >= thresholds.leading) return "leading";
  return null;
}
