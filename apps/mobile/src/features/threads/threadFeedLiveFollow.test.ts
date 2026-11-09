import { describe, expect, it } from "vite-plus/test";

import {
  reduceThreadFeedFollow,
  THREAD_FEED_FOLLOW_INITIAL,
  type ThreadFeedFollowEvent,
  type ThreadFeedFollowState,
} from "./threadFeedLiveFollow";

const run = (
  events: ReadonlyArray<ThreadFeedFollowEvent>,
  from: ThreadFeedFollowState = THREAD_FEED_FOLLOW_INITIAL,
) => events.reduce(reduceThreadFeedFollow, from);

const reading: ThreadFeedFollowState = {
  following: false,
  userScroll: "idle",
  releaseIsAtEnd: false,
};

describe("thread feed live follow", () => {
  it("stops following as soon as the reader puts a finger down", () => {
    expect(run([{ type: "drag-begin" }])).toMatchObject({ following: false });
  });

  // The phone bug: a flick up from the end was released within 160 points of it, which counted
  // as "at the end", so the feed followed again while the momentum carried the reader away.
  it("does not follow again when a flick is released near the end and carries on upward", () => {
    const state = run([
      { type: "drag-begin" },
      { type: "scroll", isAtEnd: false },
      { type: "drag-end", isAtEnd: false },
      { type: "momentum-begin" },
      { type: "scroll", isAtEnd: false },
      { type: "momentum-end", isAtEnd: false },
    ]);
    expect(state).toEqual({ following: false, userScroll: "idle", releaseIsAtEnd: false });
  });

  it("waits for the momentum a release throws before deciding", () => {
    // Released at the end, but the momentum (it starts after the release) leaves it.
    const released = run([{ type: "drag-begin" }, { type: "drag-end", isAtEnd: true }]);
    expect(released).toMatchObject({ following: false, userScroll: "settling" });
    const thrown = run(
      [{ type: "momentum-begin" }, { type: "momentum-end", isAtEnd: false }],
      released,
    );
    expect(thrown.following).toBe(false);
    // The settle timer of that release may still fire: it no longer decides anything.
    expect(reduceThreadFeedFollow(thrown, { type: "settle-timeout" })).toBe(thrown);
  });

  it("follows again when the drag rests at the very end", () => {
    expect(
      run([{ type: "drag-begin" }, { type: "drag-end", isAtEnd: true }, { type: "settle-timeout" }])
        .following,
    ).toBe(true);
    expect(
      run([
        { type: "drag-begin" },
        { type: "drag-end", isAtEnd: false },
        { type: "momentum-begin" },
        { type: "momentum-end", isAtEnd: true },
      ]).following,
    ).toBe(true);
  });

  it("lets nothing but the reader's scroll stop following, and takes one that lands at the end", () => {
    // A streamed row or a list adjustment moves the offset away from the end: still following.
    expect(run([{ type: "scroll", isAtEnd: false }]).following).toBe(true);
    // Reading back, a programmatic scroll that reaches the end follows again.
    expect(run([{ type: "scroll", isAtEnd: true }], reading).following).toBe(true);
    expect(run([{ type: "scroll", isAtEnd: false }], reading).following).toBe(false);
  });

  it("keeps a scroll that passes the end during the reader's own drag from following", () => {
    expect(
      run([
        { type: "drag-begin" },
        { type: "scroll", isAtEnd: true },
        { type: "scroll", isAtEnd: false },
      ]).following,
    ).toBe(false);
  });

  it("ignores momentum it did not see start (a programmatic scroll's animation)", () => {
    expect(run([{ type: "momentum-end", isAtEnd: true }], reading)).toBe(reading);
  });

  it("follows again on reset (jump to latest, a send), also in the middle of a drag", () => {
    expect(run([{ type: "reset" }], reading)).toEqual(THREAD_FEED_FOLLOW_INITIAL);
    expect(run([{ type: "drag-begin" }, { type: "reset" }, { type: "settle-timeout" }])).toEqual(
      THREAD_FEED_FOLLOW_INITIAL,
    );
  });
});
