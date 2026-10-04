import { describe, expect, it } from "vite-plus/test";

import { createInterruptQueueHold, type QueueHold } from "./hold.ts";
import { createMessageQueueStore } from "./store.ts";

function setup() {
  const store = createMessageQueueStore();
  const state = store.getState();
  state.enqueue("env:thread", {
    id: "first",
    composer: { prompt: "first", attachments: [{ uploadToken: "retained" }] },
    settings: { model: "chosen-model" },
  });
  state.enqueue("env:thread", { id: "second", composer: {}, settings: {} });
  return store;
}

describe("queued send ownership", () => {
  it("claims synchronously and prevents duplicate/concurrent sends in the same thread", () => {
    const store = setup();
    expect(store.getState().beginSend("env:thread", "first")).toBe(true);
    expect(store.getState().beginSend("env:thread", "first")).toBe(false);
    expect(store.getState().beginSend("env:thread", "second")).toBe(false);
  });

  it("removes the accepted id even when the queue was reordered during dispatch", () => {
    const store = setup();
    store.getState().beginSend("env:thread", "first");
    store.getState().move("env:thread", "second", "up");
    store.getState().finishSend("env:thread", "first", true);
    expect(store.getState().queuesByThreadKey["env:thread"]?.map((entry) => entry.id)).toEqual([
      "second",
    ]);
  });

  it("retains the complete snapshot on failure and requires explicit retry", () => {
    const store = setup();
    const original = store.getState().queuesByThreadKey["env:thread"]![0]!;
    store.getState().beginSend("env:thread", "first");
    store.getState().finishSend("env:thread", "first", false);
    expect(store.getState().queuesByThreadKey["env:thread"]![0]).toEqual({
      ...original,
      deliveryStatus: "failed",
    });
    expect(store.getState().beginSend("env:thread", "first")).toBe(false);
    store.getState().retrySend("env:thread", "first");
    expect(store.getState().queuesByThreadKey["env:thread"]![0]).toEqual(original);
    expect(store.getState().beginSend("env:thread", "first")).toBe(true);
  });

  it("does not recreate removed messages or affect another environment after late completion", () => {
    const store = setup();
    store.getState().enqueue("other:thread", { id: "first", composer: {}, settings: {} });
    store.getState().beginSend("env:thread", "first");
    store.getState().clear("env:thread");
    store.getState().finishSend("env:thread", "first", false);
    expect(store.getState().queuesByThreadKey["env:thread"]).toBeUndefined();
    expect(store.getState().queuesByThreadKey["other:thread"]).toHaveLength(1);
  });

  it("does not send a message already being steered", () => {
    const store = setup();
    store.getState().beginSteer("env:thread", "first");
    expect(store.getState().beginSend("env:thread", "first")).toBe(false);
  });
});

const NOW = "2026-10-01T12:00:00.000Z";
const errorHold: QueueHold = {
  reason: "error",
  detail: "boom",
  causeKeys: ["error:turn-1:boom"],
  heldAt: NOW,
};

describe("queue holds", () => {
  it("does not hold an empty queue", () => {
    const store = createMessageQueueStore();
    expect(store.getState().hold("env:thread", createInterruptQueueHold("turn-1", NOW))).toBe(
      false,
    );
    expect(store.getState().holdsByThreadKey).toEqual({});
  });

  it("merges into the existing hold and does not notify for an identical merge", () => {
    const store = setup();
    const stop = createInterruptQueueHold("turn-1", NOW);
    expect(store.getState().hold("env:thread", stop)).toBe(true);
    expect(store.getState().hold("env:thread", errorHold)).toBe(true);
    expect(store.getState().holdsByThreadKey["env:thread"]).toEqual({
      reason: "error",
      detail: "boom",
      causeKeys: ["interrupt:turn-1", "error:turn-1:boom"],
      heldAt: NOW,
    });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    expect(store.getState().hold("env:thread", errorHold)).toBe(false);
    expect(store.getState().hold("env:thread", stop)).toBe(false);
    unsubscribe();
    expect(notifications).toBe(0);
  });

  it("releases by acknowledging, and removes causes without acknowledging", () => {
    const store = setup();
    store.getState().hold("env:thread", createInterruptQueueHold("turn-1", NOW));
    store.getState().hold("env:thread", errorHold);
    store.getState().removeHoldCauses("env:thread", ["interrupt:turn-1"]);
    expect(store.getState().holdsByThreadKey["env:thread"]?.causeKeys).toEqual([
      "error:turn-1:boom",
    ]);
    expect(store.getState().acknowledgedCauseKeysByThreadKey["env:thread"]).toBeUndefined();
    store.getState().removeHoldCauses("env:thread", ["error:turn-1:boom"]);
    expect(store.getState().holdsByThreadKey["env:thread"]).toBeUndefined();

    // A released stall leaves the Stop's reason, not the stall copy.
    store.getState().hold("env:thread", createInterruptQueueHold(null, NOW));
    store.getState().hold("env:thread", {
      reason: "stalled",
      detail: null,
      causeKeys: ["stalled:q-1"],
      heldAt: NOW,
    });
    expect(store.getState().holdsByThreadKey["env:thread"]?.reason).toBe("stalled");
    store.getState().removeHoldCauses("env:thread", ["stalled:q-1"]);
    expect(store.getState().holdsByThreadKey["env:thread"]).toMatchObject({
      reason: "interrupted",
      causeKeys: [`interrupt:user:${NOW}`],
    });
    store.getState().removeHoldCauses("env:thread", [`interrupt:user:${NOW}`]);

    store.getState().hold("env:thread", errorHold);
    store.getState().release("env:thread", ["error:turn-1:boom", "interrupt:turn-1"]);
    expect(store.getState().holdsByThreadKey["env:thread"]).toBeUndefined();
    expect(store.getState().acknowledgedCauseKeysByThreadKey["env:thread"]).toEqual([
      "error:turn-1:boom",
      "interrupt:turn-1",
    ]);
  });

  it("records an empty baseline and appends acknowledged causes", () => {
    const store = setup();
    store.getState().acknowledgeCauses("env:thread", []);
    expect(store.getState().acknowledgedCauseKeysByThreadKey["env:thread"]).toEqual([]);
    store.getState().acknowledgeCauses("env:thread", ["a", "a", "b"]);
    expect(store.getState().acknowledgedCauseKeysByThreadKey["env:thread"]).toEqual(["a", "b"]);
  });

  it.each([
    [
      "remove",
      (store: ReturnType<typeof setup>) => {
        store.getState().remove("env:thread", "first");
        store.getState().remove("env:thread", "second");
      },
    ],
    [
      "accepted sends",
      (store: ReturnType<typeof setup>) => {
        for (const id of ["first", "second"]) {
          store.getState().beginSend("env:thread", id);
          store.getState().finishSend("env:thread", id, true);
        }
      },
    ],
    [
      "dequeue",
      (store: ReturnType<typeof setup>) => {
        store.getState().dequeue("env:thread");
        store.getState().dequeue("env:thread");
      },
    ],
    ["clear", (store: ReturnType<typeof setup>) => store.getState().clear("env:thread")],
  ] as const)("drops the hold and baseline when %s empties the queue", (_label, empty) => {
    const store = setup();
    store.getState().acknowledgeCauses("env:thread", ["seen"]);
    store.getState().hold("env:thread", errorHold);
    empty(store);
    expect(store.getState().holdsByThreadKey["env:thread"]).toBeUndefined();
    expect(store.getState().acknowledgedCauseKeysByThreadKey["env:thread"]).toBeUndefined();
  });

  it("keeps the hold while messages remain", () => {
    const store = setup();
    store.getState().hold("env:thread", errorHold);
    store.getState().remove("env:thread", "first");
    expect(store.getState().holdsByThreadKey["env:thread"]).toEqual(errorHold);
  });

  it("releases a send claim back to no status", () => {
    const store = setup();
    store.getState().beginSend("env:thread", "first");
    store.getState().releaseSend("env:thread", "first");
    expect(store.getState().queuesByThreadKey["env:thread"]![0]!.deliveryStatus).toBeUndefined();
    expect(store.getState().beginSend("env:thread", "first")).toBe(true);
  });

  it("resets everything and bumps the epoch", () => {
    const store = setup();
    store.getState().beginSteer("env:thread", "second");
    store.getState().acknowledgeCauses("env:thread", ["seen"]);
    store.getState().hold("env:thread", errorHold);
    const epoch = store.getState().epoch;
    store.getState().reset();
    const state = store.getState();
    expect(state.queuesByThreadKey).toEqual({});
    expect(state.steeringIdsByThreadKey).toEqual({});
    expect(state.holdsByThreadKey).toEqual({});
    expect(state.acknowledgedCauseKeysByThreadKey).toEqual({});
    expect(state.epoch).toBe(epoch + 1);
  });
});
