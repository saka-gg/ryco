import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  applyThreadPin,
  pinnedThreadKeyList,
  requestThreadPinChange,
  sanitizePinnedThreadKeys,
  setThreadKeyPinned,
  type ThreadPinStore,
} from "./threadPins.ts";

const target = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

function memoryStore(initial: Record<string, boolean> = {}) {
  let pins: Record<string, boolean> = initial;
  const listeners = new Set<() => void>();
  const store: ThreadPinStore = {
    isPinned: (key) => pins[key] === true,
    setPinned: (key, pinned) => {
      pins = setThreadKeyPinned(pins, key, pinned);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { store, read: () => pins };
}

describe("thread pins", () => {
  it("keeps the same record when a pin does not change", () => {
    const pins = { "env:a": true };
    expect(setThreadKeyPinned(pins, "env:a", true)).toBe(pins);
    expect(setThreadKeyPinned(pins, "env:b", false)).toBe(pins);
    expect(setThreadKeyPinned(pins, "env:b", true)).toEqual({ "env:a": true, "env:b": true });
    expect(setThreadKeyPinned(pins, "env:a", false)).toEqual({});
  });

  it("round-trips the persisted list", () => {
    expect(sanitizePinnedThreadKeys([" env:a ", "env:a", "", 4, "env:b"])).toEqual({
      "env:a": true,
      "env:b": true,
    });
    expect(sanitizePinnedThreadKeys("env:a")).toEqual({});
    expect(pinnedThreadKeyList({ "env:a": true, "env:b": false, "env:c": true })).toEqual([
      "env:a",
      "env:c",
    ]);
  });

  it("pins through supersede and unpins through the Undo history", () => {
    const { store, read } = memoryStore();
    const undo = { supersede: vi.fn(), unpin: vi.fn() };
    applyThreadPin({ target, threadKey: "env:thread", pinned: true }, store, undo);
    expect(undo.supersede).toHaveBeenCalledWith(target);
    expect(read()).toEqual({ "env:thread": true });

    applyThreadPin({ target, threadKey: "env:thread", pinned: false }, store, undo);
    const [unpinTarget, pin] = undo.unpin.mock.calls[0]!;
    expect(unpinTarget).toBe(target);
    expect(pin.read()).toBe(true);
    pin.write(false);
    expect(read()).toEqual({});
  });

  it("reports a pin write that throws and leaves it unchanged", async () => {
    const failed = vi.fn();
    const result = await requestThreadPinChange(
      { threadKey: "env:thread", threadTitle: "T", pinned: true, confirmUnpin: false },
      {
        isPinned: () => false,
        setPinned: () => {
          throw new Error("storage full");
        },
        confirm: async () => true,
        failed,
      },
    );
    expect(result).toBe("unchanged");
    expect(failed).toHaveBeenCalledWith(new Error("storage full"));
  });
});
