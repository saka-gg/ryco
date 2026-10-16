import { MessageId } from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useTimelineRevealStore } from "./timelineRevealStore";

describe("timeline reveal requests", () => {
  afterEach(() => useTimelineRevealStore.setState({ requestsByThreadKey: {} }));

  it("gives every request its own id, so the same message can be shown again", () => {
    const { reveal } = useTimelineRevealStore.getState();
    reveal("env:thread-1", MessageId.make("m1"));
    const first = useTimelineRevealStore.getState().requestsByThreadKey["env:thread-1"];
    reveal("env:thread-1", MessageId.make("m1"));
    const second = useTimelineRevealStore.getState().requestsByThreadKey["env:thread-1"];
    expect(first?.messageId).toBe("m1");
    expect(second?.messageId).toBe("m1");
    expect(second?.requestId).toBeGreaterThan(first!.requestId);
  });

  it("settles a request only while no newer one replaced it", () => {
    const { reveal, settle } = useTimelineRevealStore.getState();
    reveal("env:thread-1", MessageId.make("m1"));
    reveal("env:thread-2", MessageId.make("m9"));
    const stale = useTimelineRevealStore.getState().requestsByThreadKey["env:thread-1"]!;
    reveal("env:thread-1", MessageId.make("m2"));

    settle("env:thread-1", stale.requestId);
    expect(useTimelineRevealStore.getState().requestsByThreadKey["env:thread-1"]?.messageId).toBe(
      "m2",
    );

    const current = useTimelineRevealStore.getState().requestsByThreadKey["env:thread-1"]!;
    settle("env:thread-1", current.requestId);
    expect(Object.keys(useTimelineRevealStore.getState().requestsByThreadKey)).toEqual([
      "env:thread-2",
    ]);
  });
});
