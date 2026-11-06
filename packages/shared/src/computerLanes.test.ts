import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_LANE_INPUT,
  ComputerLaneError,
  ComputerLaneScheduler,
  computerAppLane,
  computerExclusiveLane,
  computerLaneClaim,
  computerLanesConflict,
  computerLanesCover,
  computerReadLane,
  computerWindowLane,
  withComputerLaneClaims,
  type ComputerLaneClaim,
  type ComputerLaneHold,
} from "./computerLanes.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Tracks which acquisitions have been admitted, in order. */
function track(scheduler: ComputerLaneScheduler) {
  const admitted: string[] = [];
  const holds = new Map<string, ComputerLaneHold>();
  const errors = new Map<string, unknown>();
  const request = (
    name: string,
    claims: readonly ComputerLaneClaim[],
    options?: Parameters<ComputerLaneScheduler["acquire"]>[1],
  ) =>
    scheduler.acquire(claims, options).then(
      (hold) => {
        admitted.push(name);
        holds.set(name, hold);
      },
      (error: unknown) => {
        errors.set(name, error);
      },
    );
  const release = (name: string) => holds.get(name)!.release();
  return { admitted, errors, request, release };
}

describe("computer lane claims", () => {
  it("treats ancestors and descendants as the same resource", () => {
    expect(computerLanesConflict(computerAppLane(10), computerWindowLane(1, 10))).toBe(true);
    expect(computerLanesConflict(computerWindowLane(1, 10), computerWindowLane(2, 10))).toBe(false);
    expect(computerLanesConflict(computerAppLane(10), computerAppLane(11))).toBe(false);
    expect(computerLanesConflict(computerAppLane(10), computerAppLane(10))).toBe(true);
    // A pid prefix is not an ancestor: app:1 is unrelated to app:10.
    expect(computerLanesConflict(computerAppLane(1), computerWindowLane(5, 10))).toBe(false);
    expect(computerLanesConflict(computerReadLane(), computerAppLane(10))).toBe(false);
    expect(computerLanesConflict(computerReadLane(), computerExclusiveLane())).toBe(true);
  });

  it("covers nested work only when the held lane is at least as strong", () => {
    expect(computerLanesCover(computerExclusiveLane(), computerAppLane(3))).toBe(true);
    expect(computerLanesCover(computerAppLane(3), computerWindowLane(9, 3))).toBe(true);
    expect(computerLanesCover(computerAppLane(3), computerReadLane())).toBe(true);
    expect(computerLanesCover(computerAppLane(3), computerAppLane(4))).toBe(false);
    expect(computerLanesCover(computerReadLane(), computerAppLane(3))).toBe(false);
    expect(computerLanesCover(computerAppLane(3), computerExclusiveLane())).toBe(false);
    expect(computerLanesCover(computerWindowLane(9, 3), computerAppLane(3))).toBe(false);
  });

  it("merges duplicate claims to the stronger mode", () => {
    expect(
      withComputerLaneClaims(
        computerReadLane(),
        computerLaneClaim.exclusive(COMPUTER_LANE_INPUT),
        computerLaneClaim.shared(COMPUTER_LANE_INPUT),
      ),
    ).toEqual([
      { resource: "desktop", mode: "shared" },
      { resource: "input", mode: "exclusive" },
    ]);
  });
});

describe("ComputerLaneScheduler", () => {
  it("runs work on different apps at the same time", async () => {
    const lanes = new ComputerLaneScheduler();
    const { admitted, request } = track(lanes);
    void request("safari", computerAppLane(1));
    void request("notes", computerAppLane(2));
    void request("read", computerReadLane());
    await flush();
    expect(admitted).toEqual(["safari", "notes", "read"]);
  });

  it("queues work on the same app in FIFO order", async () => {
    const lanes = new ComputerLaneScheduler();
    const { admitted, request, release } = track(lanes);
    void request("a1", computerAppLane(1));
    void request("a2", computerAppLane(1));
    void request("a3", computerWindowLane(7, 1));
    void request("other", computerAppLane(2));
    await flush();
    expect(admitted).toEqual(["a1", "other"]);
    release("a1");
    await flush();
    expect(admitted).toEqual(["a1", "other", "a2"]);
    release("a2");
    await flush();
    expect(admitted).toEqual(["a1", "other", "a2", "a3"]);
  });

  it("lets semantic writes on different windows of one app overlap", async () => {
    const lanes = new ComputerLaneScheduler();
    const { admitted, request } = track(lanes);
    void request("w1", computerWindowLane(1, 5));
    void request("w2", computerWindowLane(2, 5));
    await flush();
    expect(admitted).toEqual(["w1", "w2"]);
  });

  it("never makes reads wait for input on another app", async () => {
    const lanes = new ComputerLaneScheduler();
    const { admitted, request } = track(lanes);
    void request("input", computerAppLane(1));
    void request("input-again", computerAppLane(1));
    void request("read", computerReadLane());
    await flush();
    expect(admitted).toEqual(["input", "read"]);
  });

  it("makes whole-desktop work a barrier in both directions", async () => {
    const lanes = new ComputerLaneScheduler();
    const { admitted, request, release } = track(lanes);
    void request("app", computerAppLane(1));
    void request("foreground", computerExclusiveLane());
    // Queued after the exclusive request: waits even though it is compatible
    // with what runs now, so the barrier is not starved.
    void request("late-read", computerReadLane());
    void request("late-app", computerAppLane(2));
    await flush();
    expect(admitted).toEqual(["app"]);
    release("app");
    await flush();
    expect(admitted).toEqual(["app", "foreground"]);
    release("foreground");
    await flush();
    expect(admitted).toEqual(["app", "foreground", "late-read", "late-app"]);
  });

  it("serializes host input on the shared gate while semantic writes share it", async () => {
    const lanes = new ComputerLaneScheduler();
    const { admitted, request, release } = track(lanes);
    const nativeInput = (app: number) =>
      withComputerLaneClaims(
        computerAppLane(app),
        computerLaneClaim.exclusive(COMPUTER_LANE_INPUT),
      );
    const semantic = (window: number, app: number) =>
      withComputerLaneClaims(
        computerWindowLane(window, app),
        computerLaneClaim.shared(COMPUTER_LANE_INPUT),
      );
    void request("s1", semantic(1, 1));
    void request("s2", semantic(2, 2));
    void request("pixel", nativeInput(3));
    void request("read", computerReadLane());
    await flush();
    expect(admitted).toEqual(["s1", "s2", "read"]);
    release("s1");
    await flush();
    expect(admitted).toEqual(["s1", "s2", "read"]);
    release("s2");
    await flush();
    expect(admitted).toEqual(["s1", "s2", "read", "pixel"]);
  });

  it("times out a bounded wait and lets later work run", async () => {
    vi.useFakeTimers();
    try {
      const lanes = new ComputerLaneScheduler();
      const { admitted, errors, request } = track(lanes);
      void request("owner", computerAppLane(1));
      void request("waiter", computerAppLane(1), {
        timeoutMs: 1_000,
        timeoutMessage: "Safari is busy.",
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(errors.has("waiter")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = errors.get("waiter");
      expect(error).toBeInstanceOf(ComputerLaneError);
      expect((error as ComputerLaneError).failure).toBe("timeout");
      expect((error as ComputerLaneError).retryable).toBe(true);
      expect((error as Error).message).toBe("Safari is busy.");
      expect(lanes.waitingCount).toBe(0);
      expect(admitted).toEqual(["owner"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes an aborted waiter and unblocks work queued behind it", async () => {
    const lanes = new ComputerLaneScheduler();
    const { admitted, errors, request } = track(lanes);
    const controller = new AbortController();
    void request("read", computerReadLane());
    void request("foreground", computerExclusiveLane(), { signal: controller.signal });
    void request("late-read", computerReadLane());
    await flush();
    expect(admitted).toEqual(["read"]);
    controller.abort(new Error("stopped"));
    await flush();
    expect((errors.get("foreground") as Error).message).toBe("stopped");
    expect(admitted).toEqual(["read", "late-read"]);
  });

  it("refuses an already aborted request without queueing it", async () => {
    const lanes = new ComputerLaneScheduler();
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(lanes.acquire(computerReadLane(), { signal: controller.signal })).rejects.toThrow(
      "gone",
    );
    expect(lanes.waitingCount).toBe(0);
  });

  it("bounds the queue and closes cleanly", async () => {
    const lanes = new ComputerLaneScheduler({ limit: 1 });
    const { errors, request, release } = track(lanes);
    void request("owner", computerExclusiveLane());
    void request("queued", computerReadLane());
    void request("overflow", computerReadLane());
    await flush();
    expect((errors.get("overflow") as ComputerLaneError).failure).toBe("full");
    lanes.close();
    await flush();
    expect((errors.get("queued") as ComputerLaneError).failure).toBe("closed");
    await expect(lanes.acquire(computerReadLane())).rejects.toMatchObject({ failure: "closed" });
    release("owner");
    expect(lanes.runningCount).toBe(0);
  });

  it("releases a hold once even when released twice", async () => {
    const lanes = new ComputerLaneScheduler();
    const first = await lanes.acquire(computerReadLane());
    const second = await lanes.acquire(computerReadLane());
    first.release();
    first.release();
    expect(lanes.runningCount).toBe(1);
    second.release();
    expect(lanes.runningCount).toBe(0);
  });

  it("run releases the lane when the action throws", async () => {
    const lanes = new ComputerLaneScheduler();
    await expect(
      lanes.run(computerExclusiveLane(), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lanes.runningCount).toBe(0);
  });

  it("uses the product error factory", async () => {
    class ProductError extends Error {}
    const lanes = new ComputerLaneScheduler({
      createError: (_failure, message) => new ProductError(message),
    });
    lanes.close();
    await expect(lanes.acquire(computerReadLane())).rejects.toBeInstanceOf(ProductError);
  });
});
