/**
 * Whether the thread feed follows its end as messages arrive. Ported from t3code's
 * `thread-feed-live-follow.ts` (see NOTICE.md): only the reader's own scroll (a drag and its
 * momentum) stops following; programmatic scrolls and list adjustments never do; coming back to
 * the end, or tapping "jump to latest", follows again.
 */
export type ThreadFeedLiveFollowEvent =
  | { readonly type: "reset" }
  | { readonly type: "user-scroll-begin" }
  | {
      readonly type: "user-scroll-end";
      readonly isAtEnd: boolean;
      readonly userScrollSessionActive: boolean;
    }
  | {
      readonly type: "scroll";
      readonly isAtEnd: boolean;
      readonly userScrollSessionActive: boolean;
    };

export function resolveThreadFeedLiveFollow(
  current: boolean,
  event: ThreadFeedLiveFollowEvent,
): boolean {
  switch (event.type) {
    case "reset":
      return true;
    case "user-scroll-begin":
      return false;
    case "user-scroll-end":
      return event.userScrollSessionActive ? event.isAtEnd : current;
    case "scroll":
      if (event.userScrollSessionActive) return false;
      if (event.isAtEnd) return true;
      return current;
  }
}
