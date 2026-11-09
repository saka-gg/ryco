// When the chat's composer shrinks into the small "Message" bubble at the bottom right, so a
// reader scrolling back through the chat gets (almost) the whole screen, and when it comes back.
// Pure, so the rules are tested without a list or a gesture.

/** Within this many points of the end the composer is always there (the prototype's 40). */
export const COMPOSER_RESTORE_DISTANCE = 40;
/** An upward move smaller than this is jitter, not the reader scrolling back. */
export const COMPOSER_SHRINK_MIN_STEP = 2;
/**
 * Room above the restore distance a shrink has to leave: the feed grows by the composer's
 * height when it shrinks, and the end must then still be out of reach, or the two would toggle.
 */
const SHRINK_SLACK = 24;

export interface ComposerShrinkState {
  readonly collapsed: boolean;
  /** The feed offset of the previous scroll event; null before the first. */
  readonly lastOffsetY: number | null;
}

export const INITIAL_COMPOSER_SHRINK: ComposerShrinkState = { collapsed: false, lastOffsetY: null };

export interface ComposerShrinkScroll {
  readonly offsetY: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
  /** The reader's own drag (or its momentum) moves the feed, not an arriving message. */
  readonly userScrolling: boolean;
  /** The composer's full height: what the feed gains while it is shrunk. */
  readonly composerHeight: number;
}

/**
 * The next state after a feed scroll event. The composer shrinks only while the reader scrolls
 * back up (away from the end) far enough from it, and comes back once the feed is at the end.
 */
export function nextComposerShrink(
  state: ComposerShrinkState,
  scroll: ComposerShrinkScroll,
): ComposerShrinkState {
  const distanceFromEnd = scroll.contentHeight - (scroll.offsetY + scroll.viewportHeight);
  const movedUp =
    state.lastOffsetY !== null && scroll.offsetY < state.lastOffsetY - COMPOSER_SHRINK_MIN_STEP;
  let collapsed = state.collapsed;
  if (distanceFromEnd <= COMPOSER_RESTORE_DISTANCE) {
    collapsed = false;
  } else if (
    !collapsed &&
    movedUp &&
    scroll.userScrolling &&
    distanceFromEnd > COMPOSER_RESTORE_DISTANCE + Math.max(0, scroll.composerHeight) + SHRINK_SLACK
  ) {
    collapsed = true;
  }
  if (collapsed === state.collapsed && scroll.offsetY === state.lastOffsetY) return state;
  return { collapsed, lastOffsetY: scroll.offsetY };
}

/** What keeps the composer out: the reader is writing, dictating or picking a command. */
export interface ComposerShrinkHolds {
  readonly focused: boolean;
  readonly hasText: boolean;
  readonly hasAttachments: boolean;
  readonly dictating: boolean;
  readonly commandMenuOpen: boolean;
}

export function composerShrinkHeld(holds: ComposerShrinkHolds): boolean {
  return (
    holds.focused ||
    holds.hasText ||
    holds.hasAttachments ||
    holds.dictating ||
    holds.commandMenuOpen
  );
}
