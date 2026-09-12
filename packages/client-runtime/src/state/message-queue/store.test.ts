import { describe, expect, it } from "vite-plus/test";

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
