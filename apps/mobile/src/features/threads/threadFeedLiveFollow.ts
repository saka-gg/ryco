/**
 * Whether the thread feed follows its end as messages arrive. Ported from t3code's
 * `thread-feed-live-follow.ts` and the scroll handlers of its `ThreadFeed.tsx` (see NOTICE.md):
 * only the reader's own scroll (a drag and the momentum it throws) stops following; programmatic
 * scrolls and list adjustments never do; coming back to the very end, or tapping "jump to
 * latest", follows again.
 *
 * "The end" is the list's own end (LegendList's `isAtEnd`), not a band near it: a flick that is
 * released close to the end but carries on upward must not follow again, or the feed would hold
 * the reader's place as if they were at the end (no anchoring while older history loads, no
 * "jump to latest" button) while they read back.
 */

/** How long a released drag waits for its momentum before it counts as over (t3code's value). */
export const THREAD_FEED_USER_SCROLL_SETTLE_MS = 160;

export interface ThreadFeedFollowState {
  readonly following: boolean;
  /**
   * The reader's scroll in progress: their finger is down (`dragging`), it lifted and the
   * momentum may still start (`settling`), or the momentum runs (`momentum`).
   */
  readonly userScroll: "idle" | "dragging" | "settling" | "momentum";
  /** Whether the list rested at its end when the finger lifted: the outcome if no momentum comes. */
  readonly releaseIsAtEnd: boolean;
}

export const THREAD_FEED_FOLLOW_INITIAL: ThreadFeedFollowState = {
  following: true,
  userScroll: "idle",
  releaseIsAtEnd: true,
};

export type ThreadFeedFollowEvent =
  /** Jump to latest, or a send: follow the end again. */
  | { readonly type: "reset" }
  | { readonly type: "drag-begin" }
  | { readonly type: "drag-end"; readonly isAtEnd: boolean }
  | { readonly type: "momentum-begin" }
  | { readonly type: "momentum-end"; readonly isAtEnd: boolean }
  /** The released drag threw no momentum within `THREAD_FEED_USER_SCROLL_SETTLE_MS`. */
  | { readonly type: "settle-timeout" }
  | { readonly type: "scroll"; readonly isAtEnd: boolean };

export function reduceThreadFeedFollow(
  state: ThreadFeedFollowState,
  event: ThreadFeedFollowEvent,
): ThreadFeedFollowState {
  switch (event.type) {
    case "reset":
      return THREAD_FEED_FOLLOW_INITIAL;
    case "drag-begin":
      // Stop before the first scroll event: a streamed row could otherwise pull the feed back to
      // its end between touch-down and the drag leaving its threshold.
      return { following: false, userScroll: "dragging", releaseIsAtEnd: false };
    case "drag-end":
      return state.userScroll === "dragging"
        ? { ...state, userScroll: "settling", releaseIsAtEnd: event.isAtEnd }
        : state;
    case "momentum-begin":
      return state.userScroll === "dragging" || state.userScroll === "settling"
        ? { ...state, userScroll: "momentum" }
        : state;
    case "momentum-end":
      return state.userScroll === "momentum"
        ? { following: event.isAtEnd, userScroll: "idle", releaseIsAtEnd: event.isAtEnd }
        : state;
    case "settle-timeout":
      return state.userScroll === "settling"
        ? {
            following: state.releaseIsAtEnd,
            userScroll: "idle",
            releaseIsAtEnd: state.releaseIsAtEnd,
          }
        : state;
    case "scroll":
      if (state.userScroll !== "idle")
        return state.following ? { ...state, following: false } : state;
      // A programmatic scroll or list adjustment: only one that lands at the end follows again.
      return event.isAtEnd && !state.following ? { ...state, following: true } : state;
  }
}

/**
 * How the list keeps (or stops keeping) its end, for one follow state. Following is this module's
 * decision, so the list must not second-guess it: LegendList by default keeps the end only while
 * the list sits within 10% of a viewport of it, and a turn grows the end by more than that in one
 * step (the finished reply re-laid out, the status capsule's footer coming or going). The list was
 * then left short of the end while the feed still counted as following: new rows stayed hidden
 * under the composer and no "jump to latest" showed. While following, the end is kept from any
 * distance and on every change, the footer's included; reading back, the rows on screen stay put.
 */
export interface ThreadFeedEndMaintenance {
  readonly maintainScrollAtEnd:
    | false
    | {
        readonly animated: false;
        readonly on: {
          readonly dataChange: true;
          readonly itemLayout: true;
          readonly layout: true;
          readonly footerLayout: true;
        };
      };
  readonly maintainScrollAtEndThreshold: number;
  readonly maintainVisibleContentPosition: boolean;
}

/** LegendList's own default: what "near the end" means when the feed does not follow. */
const LIST_DEFAULT_END_THRESHOLD = 0.1;

// One object per state, so a render that keeps the state hands the list the same props.
const FOLLOWING_END: ThreadFeedEndMaintenance = {
  // Following, the measured end is kept at once (animating estimates races row measurement).
  maintainScrollAtEnd: {
    animated: false,
    on: { dataChange: true, itemLayout: true, layout: true, footerLayout: true },
  },
  maintainScrollAtEndThreshold: Number.POSITIVE_INFINITY,
  maintainVisibleContentPosition: false,
};
const READING_BACK: ThreadFeedEndMaintenance = {
  maintainScrollAtEnd: false,
  maintainScrollAtEndThreshold: LIST_DEFAULT_END_THRESHOLD,
  maintainVisibleContentPosition: true,
};

export function threadFeedEndMaintenance(following: boolean): ThreadFeedEndMaintenance {
  return following ? FOLLOWING_END : READING_BACK;
}
