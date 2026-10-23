import { MessageId } from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useTimelineRevealStore } from "./timelineRevealStore";

describe("timeline reveal requests", () => {
  afterEach(() =>
    useTimelineRevealStore.setState({ requestsByThreadKey: {}, settledByThreadKey: {} }),
  );

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

    settle("env:thread-1", stale.requestId, "missing");
    expect(useTimelineRevealStore.getState().requestsByThreadKey["env:thread-1"]?.messageId).toBe(
      "m2",
    );
    expect(useTimelineRevealStore.getState().settledByThreadKey["env:thread-1"]).toBeUndefined();

    const current = useTimelineRevealStore.getState().requestsByThreadKey["env:thread-1"]!;
    settle("env:thread-1", current.requestId, "shown");
    expect(Object.keys(useTimelineRevealStore.getState().requestsByThreadKey)).toEqual([
      "env:thread-2",
    ]);
  });

  it("keeps how each thread's last request ended, for whoever waits on it", () => {
    const { reveal, settle } = useTimelineRevealStore.getState();
    reveal("env:thread-1", MessageId.make("m1"));
    const failed = useTimelineRevealStore.getState().requestsByThreadKey["env:thread-1"]!;
    settle("env:thread-1", failed.requestId, "failed");
    expect(useTimelineRevealStore.getState().settledByThreadKey["env:thread-1"]).toEqual({
      requestId: failed.requestId,
      settlement: "failed",
    });

    reveal("env:thread-1", MessageId.make("m1"));
    const missing = useTimelineRevealStore.getState().requestsByThreadKey["env:thread-1"]!;
    settle("env:thread-1", missing.requestId, "missing");
    expect(useTimelineRevealStore.getState().settledByThreadKey["env:thread-1"]).toEqual({
      requestId: missing.requestId,
      settlement: "missing",
    });
  });
});
