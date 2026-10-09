import { describe, expect, it, vi } from "vite-plus/test";
import type { AppLifecycleEvent } from "../platform/index.ts";
import { bindConnectivityRecovery } from "./connectivityRecovery.ts";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function harness() {
  let foreground = true;
  let online = true;
  let listener: (event: AppLifecycleEvent) => void = () => undefined;
  const cleanup = Promise.withResolvers<void>();
  const recovery = Promise.withResolvers<void>();
  const settled = vi.fn();
  const input = {
    lifecycle: {
      isForeground: () => foreground,
      isOnline: () => online,
      subscribe: (fn: typeof listener) => {
        listener = fn;
        return vi.fn();
      },
    },
    suspend: vi.fn(),
    releaseBackground: vi.fn(() => cleanup.promise),
    recover: vi.fn(() => recovery.promise),
    beginWake: vi.fn(() => settled),
    cancelWake: vi.fn(),
  };
  const dispose = bindConnectivityRecovery(input);
  return {
    ...input,
    cleanup,
    recovery,
    settled,
    dispose,
    emit(event: AppLifecycleEvent) {
      if (event === "background") foreground = false;
      if (event === "foreground") foreground = true;
      if (event === "offline") online = false;
      if (event === "online") online = true;
      listener(event);
    },
  };
}

describe("connectivity recovery", () => {
  it("suspends immediately and waits for background cleanup before one foreground recovery", async () => {
    const h = harness();
    h.emit("background");
    expect(h.suspend).toHaveBeenCalledWith("hidden");
    h.emit("foreground");
    h.emit("online");
    await flush();
    expect(h.recover).not.toHaveBeenCalled();
    h.cleanup.resolve();
    await flush();
    expect(h.recover).toHaveBeenCalledOnce();
    h.emit("online");
    h.recovery.resolve();
    await flush();
    expect(h.settled).toHaveBeenCalledOnce();
    expect(h.suspend).toHaveBeenCalledOnce();
    h.dispose();
  });

  it("does not wake sockets on connectivity changes while backgrounded", async () => {
    const h = harness();
    h.emit("background");
    h.emit("offline");
    h.emit("online");
    h.cleanup.resolve();
    await flush();
    expect(h.recover).not.toHaveBeenCalled();
    h.dispose();
  });

  it("fences stale recovery and serializes another recovery after a second wake", async () => {
    const h = harness();
    h.emit("foreground");
    await flush();
    h.emit("background");
    h.emit("foreground");
    h.cleanup.resolve();
    h.recovery.resolve();
    await flush();
    expect(h.recover).toHaveBeenCalledTimes(2);
    expect(h.settled).toHaveBeenCalledOnce();
    h.dispose();
  });

  it("cancels queued recovery on disposal", async () => {
    const h = harness();
    h.emit("background");
    h.emit("foreground");
    h.dispose();
    h.cleanup.resolve();
    await flush();
    expect(h.recover).not.toHaveBeenCalled();
  });
});
