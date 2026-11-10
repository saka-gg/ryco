import { describe, expect, it, vi } from "vite-plus/test";
import type { AppLifecycleEvent } from "../platform/index.ts";
import {
  BACKGROUND_STAY_MAX_MS,
  bindConnectivityRecovery,
  type BackgroundStayPolicy,
} from "./connectivityRecovery.ts";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function harness(options: { readonly backgroundStay?: BackgroundStayPolicy } = {}) {
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
    ...(options.backgroundStay ? { backgroundStay: options.backgroundStay } : {}),
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

/** A background stay with a fake clock and platform permission. */
function stayHarness(
  options: {
    readonly eligible?: boolean;
    readonly grant?: boolean;
    readonly remainingMs?: number;
  } = {},
) {
  let clock = 1_000;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 1;
  let expire: (() => void) | null = null;
  const end = vi.fn();
  const confirm = { result: Promise.withResolvers<boolean>() };
  const policy = {
    eligible: vi.fn(() => options.eligible ?? true),
    begin: vi.fn((onExpire: () => void) => {
      expire = onExpire;
      return options.grant === false ? null : { remainingMs: options.remainingMs ?? 29_000, end };
    }),
    confirmKept: vi.fn(() => confirm.result.promise),
    resumeKept: vi.fn(),
    now: () => clock,
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + delayMs, callback });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
  } satisfies BackgroundStayPolicy;
  const h = harness({ backgroundStay: policy });
  return {
    ...h,
    policy,
    end,
    confirm,
    /** Moves the clock; timers due by then run unless `frozen` (the OS suspended the app). */
    advance(ms: number, frozen = false) {
      clock += ms;
      if (frozen) return;
      for (const [id, timer] of [...timers]) {
        if (timer.at > clock) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    platformExpires() {
      expire?.();
    },
    pendingTimers: () => timers.size,
  };
}

describe("background stay (F1)", () => {
  it("keeps the connections through a short app switch and confirms them on return", async () => {
    const h = stayHarness();
    h.cleanup.resolve();
    h.emit("background");
    expect(h.suspend).not.toHaveBeenCalled();
    expect(h.cancelWake).not.toHaveBeenCalled();
    expect(h.releaseBackground).not.toHaveBeenCalled();
    h.advance(2_000);
    h.emit("foreground");
    expect(h.end).toHaveBeenCalledOnce();
    expect(h.policy.confirmKept).toHaveBeenCalledOnce();
    h.confirm.result.resolve(true);
    await flush();
    expect(h.policy.resumeKept).toHaveBeenCalledOnce();
    expect(h.suspend).not.toHaveBeenCalled();
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.pendingTimers()).toBe(0);
    h.dispose();
  });

  it("suspends and recovers as before when a kept connection no longer answers", async () => {
    const h = stayHarness();
    h.cleanup.resolve();
    h.emit("background");
    h.advance(2_000);
    h.emit("foreground");
    h.confirm.result.resolve(false);
    await flush();
    expect(h.policy.resumeKept).not.toHaveBeenCalled();
    expect(h.suspend).toHaveBeenCalledWith("hidden");
    expect(h.releaseBackground).toHaveBeenCalledOnce();
    expect(h.recover).toHaveBeenCalledOnce();
    h.dispose();
  });

  it("suspends when the stay runs out, then recovers on the next return", async () => {
    const h = stayHarness();
    h.cleanup.resolve();
    h.emit("background");
    h.advance(BACKGROUND_STAY_MAX_MS - 1);
    expect(h.suspend).not.toHaveBeenCalled();
    h.advance(1);
    expect(h.suspend).toHaveBeenCalledWith("hidden");
    expect(h.cancelWake).toHaveBeenCalledOnce();
    expect(h.end).toHaveBeenCalledOnce();
    h.emit("foreground");
    await flush();
    expect(h.policy.confirmKept).not.toHaveBeenCalled();
    expect(h.recover).toHaveBeenCalledOnce();
    h.dispose();
  });

  it("ends the stay before the platform's own deadline", () => {
    const h = stayHarness({ remainingMs: 10_000 });
    h.emit("background");
    h.advance(6_999);
    expect(h.suspend).not.toHaveBeenCalled();
    h.advance(1);
    expect(h.suspend).toHaveBeenCalledWith("hidden");
    h.dispose();
  });

  it("suspends at once when the platform grants too little time or none", () => {
    for (const options of [{ remainingMs: 4_000 }, { grant: false }]) {
      const h = stayHarness(options);
      h.emit("background");
      expect(h.suspend).toHaveBeenCalledWith("hidden");
      expect(h.pendingTimers()).toBe(0);
      h.dispose();
    }
  });

  it("suspends at once when the sessions are not all current", () => {
    const h = stayHarness({ eligible: false });
    h.emit("background");
    expect(h.policy.begin).not.toHaveBeenCalled();
    expect(h.suspend).toHaveBeenCalledWith("hidden");
    h.dispose();
  });

  it("suspends when the platform announces suspension or a kept connection drops", () => {
    const h = stayHarness();
    h.emit("background");
    h.platformExpires();
    expect(h.suspend).toHaveBeenCalledOnce();
    expect(h.end).toHaveBeenCalledOnce();
    expect(h.pendingTimers()).toBe(0);
    // A second announcement of the same stay does nothing.
    h.platformExpires();
    expect(h.suspend).toHaveBeenCalledOnce();
    h.dispose();
  });

  it("suspends as offline when the network goes away during the stay", () => {
    const h = stayHarness();
    h.emit("background");
    h.emit("offline");
    expect(h.suspend).toHaveBeenCalledWith("offline");
    expect(h.end).toHaveBeenCalledOnce();
    h.advance(BACKGROUND_STAY_MAX_MS);
    expect(h.suspend).toHaveBeenCalledOnce();
    h.dispose();
  });

  it("recovers from scratch when the app was frozen past the stay's end", async () => {
    const h = stayHarness();
    h.cleanup.resolve();
    h.emit("background");
    h.advance(BACKGROUND_STAY_MAX_MS + 5_000, true);
    h.emit("foreground");
    await flush();
    expect(h.policy.confirmKept).not.toHaveBeenCalled();
    expect(h.suspend).toHaveBeenCalledWith("hidden");
    expect(h.recover).toHaveBeenCalledOnce();
    h.dispose();
  });

  it("ignores a confirmation that a second app switch overtook", async () => {
    const h = stayHarness();
    h.cleanup.resolve();
    h.emit("background");
    h.emit("foreground");
    const first = h.confirm.result;
    h.confirm.result = Promise.withResolvers<boolean>();
    h.emit("background");
    expect(h.policy.begin).toHaveBeenCalledTimes(2);
    first.resolve(false);
    await flush();
    expect(h.suspend).not.toHaveBeenCalled();
    expect(h.recover).not.toHaveBeenCalled();
    h.emit("foreground");
    h.confirm.result.resolve(true);
    await flush();
    expect(h.policy.resumeKept).toHaveBeenCalledOnce();
    h.dispose();
  });

  it("gives the permission back on disposal", () => {
    const h = stayHarness();
    h.emit("background");
    h.dispose();
    expect(h.end).toHaveBeenCalledOnce();
    expect(h.pendingTimers()).toBe(0);
  });
});
