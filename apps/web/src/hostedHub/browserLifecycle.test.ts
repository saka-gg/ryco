import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  bindHostedBrowserLifecycle,
  HOSTED_HIDDEN_GRACE_MS,
  type HostedBrowserLifecyclePorts,
} from "./browserLifecycle";

function harness(
  options: {
    readonly visible?: boolean;
    readonly ports?: Partial<HostedBrowserLifecyclePorts>;
  } = {},
) {
  const document = new EventTarget();
  const window = new EventTarget();
  let visible = options.visible ?? true;
  let online = true;
  const suspend = vi.fn();
  const recover = vi.fn(async (): Promise<void> => undefined);
  const setBackgrounded = vi.fn(async (_backgrounded: boolean) => undefined);
  const probe = vi.fn();
  const network = new EventTarget();
  const stop = bindHostedBrowserLifecycle({
    document,
    window,
    isVisible: () => visible,
    isOnline: () => online,
    suspend,
    recover,
    setBackgrounded,
    probe,
    subscribeNetworkChange: (listener) => {
      network.addEventListener("change", listener);
      return () => network.removeEventListener("change", listener);
    },
    ...options.ports,
  });
  return {
    document,
    window,
    network,
    suspend,
    recover,
    setBackgrounded,
    probe,
    stop,
    setVisible(value: boolean) {
      visible = value;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    setOnline(value: boolean) {
      online = value;
      window.dispatchEvent(new Event(value ? "online" : "offline"));
    },
  };
}

describe("hosted browser lifecycle", () => {
  it("probes the account connection on every foreground, online and network-change signal", () => {
    const h = harness();
    try {
      h.setVisible(false);
      expect(h.probe).not.toHaveBeenCalled();
      h.setVisible(true);
      expect(h.probe).toHaveBeenCalledTimes(1);
      h.window.dispatchEvent(new Event("pageshow"));
      expect(h.probe).toHaveBeenCalledTimes(2);
      h.network.dispatchEvent(new Event("change"));
      expect(h.probe).toHaveBeenCalledTimes(3);
      h.setOnline(false);
      h.network.dispatchEvent(new Event("change"));
      expect(h.probe).toHaveBeenCalledTimes(3);
      h.setOnline(true);
      expect(h.probe).toHaveBeenCalledTimes(4);
    } finally {
      h.stop();
    }
    h.network.dispatchEvent(new Event("change"));
    expect(h.probe).toHaveBeenCalledTimes(4);
  });

  it("keeps the transport and demand when switching to another tab", async () => {
    const h = harness();
    try {
      h.setVisible(false);
      expect(h.suspend).not.toHaveBeenCalled();
      expect(h.setBackgrounded).not.toHaveBeenCalled();
      h.setVisible(true);
      await Promise.resolve();
      expect(h.recover).toHaveBeenCalledOnce();
      expect(h.setBackgrounded).toHaveBeenCalledWith(false);
      expect(h.suspend).not.toHaveBeenCalled();
    } finally {
      h.stop();
    }
  });

  it.each(["freeze", "pagehide"])(
    "withdraws authority on %s and recovers after restoration",
    async (event) => {
      const h = harness();
      try {
        const target = event === "freeze" ? h.document : h.window;
        target.dispatchEvent(new Event(event));
        expect(h.suspend).toHaveBeenCalledWith("hidden");
        expect(h.setBackgrounded).toHaveBeenCalledWith(true);
        h.window.dispatchEvent(new Event("pageshow"));
        await Promise.resolve();
        expect(h.recover).toHaveBeenCalledOnce();
        expect(h.setBackgrounded).toHaveBeenLastCalledWith(false);
      } finally {
        h.stop();
      }
    },
  );

  it("withdraws authority immediately offline and waits for a visible online page", async () => {
    const h = harness();
    try {
      h.setVisible(false);
      h.setOnline(false);
      expect(h.suspend).toHaveBeenCalledWith("offline");
      h.setOnline(true);
      expect(h.recover).not.toHaveBeenCalled();
      h.setVisible(true);
      await Promise.resolve();
      expect(h.recover).toHaveBeenCalledOnce();
    } finally {
      h.stop();
    }
  });

  it("does not wake demand when an older resume finishes after a newer suspension", async () => {
    const h = harness();
    let finish = () => {};
    h.recover.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      h.setVisible(true);
      h.setOnline(false);
      finish();
      await Promise.resolve();
      expect(h.setBackgrounded).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      h.stop();
    }
  });

  it("removes all lifecycle listeners on disposal", () => {
    const h = harness();
    h.stop();
    h.document.dispatchEvent(new Event("freeze"));
    h.setOnline(false);
    h.setVisible(true);
    h.window.dispatchEvent(new Event("pageshow"));
    expect(h.suspend).not.toHaveBeenCalled();
    expect(h.recover).not.toHaveBeenCalled();
  });
});

describe("hosted browser hidden grace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for background planning once after the grace period without suspending", () => {
    const h = harness();
    try {
      h.setVisible(false);
      vi.advanceTimersByTime(HOSTED_HIDDEN_GRACE_MS - 1);
      expect(h.setBackgrounded).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(h.setBackgrounded).toHaveBeenCalledExactlyOnceWith(true);
      vi.advanceTimersByTime(HOSTED_HIDDEN_GRACE_MS * 2);
      expect(h.setBackgrounded).toHaveBeenCalledOnce();
      expect(h.suspend).not.toHaveBeenCalled();
      expect(h.recover).not.toHaveBeenCalled();
    } finally {
      h.stop();
    }
  });

  it("does nothing when the tab is visible again before the grace period ends, then restarts the full period", async () => {
    const h = harness();
    try {
      h.setVisible(false);
      vi.advanceTimersByTime(60_000);
      h.setVisible(true);
      await Promise.resolve();
      vi.advanceTimersByTime(HOSTED_HIDDEN_GRACE_MS);
      expect(h.setBackgrounded).not.toHaveBeenCalledWith(true);

      h.setVisible(false);
      vi.advanceTimersByTime(HOSTED_HIDDEN_GRACE_MS - 1);
      expect(h.setBackgrounded).not.toHaveBeenCalledWith(true);
      vi.advanceTimersByTime(1);
      expect(h.setBackgrounded.mock.calls.filter(([value]) => value === true)).toHaveLength(1);
      expect(h.suspend).not.toHaveBeenCalled();
    } finally {
      h.stop();
    }
  });

  it("returns to foreground planning through one recovery after the grace fired", async () => {
    const h = harness();
    try {
      h.setVisible(false);
      vi.advanceTimersByTime(HOSTED_HIDDEN_GRACE_MS);
      expect(h.setBackgrounded).toHaveBeenCalledExactlyOnceWith(true);
      h.setVisible(true);
      await Promise.resolve();
      expect(h.recover).toHaveBeenCalledOnce();
      expect(h.setBackgrounded.mock.calls).toEqual([[true], [false]]);
      expect(h.suspend).not.toHaveBeenCalled();
    } finally {
      h.stop();
    }
  });

  it("keeps the suspension path on freeze and cancels the pending grace", () => {
    const h = harness();
    try {
      h.setVisible(false);
      vi.advanceTimersByTime(30_000);
      h.document.dispatchEvent(new Event("freeze"));
      expect(h.suspend).toHaveBeenCalledExactlyOnceWith("hidden");
      expect(h.setBackgrounded).toHaveBeenCalledExactlyOnceWith(true);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(HOSTED_HIDDEN_GRACE_MS * 2);
      expect(h.setBackgrounded).toHaveBeenCalledOnce();
    } finally {
      h.stop();
    }
  });

  it("does not arm the grace for a tab that is already suspended", () => {
    const h = harness();
    try {
      h.window.dispatchEvent(new Event("pagehide"));
      expect(h.setBackgrounded).toHaveBeenCalledOnce();
      h.setVisible(false);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(HOSTED_HIDDEN_GRACE_MS * 2);
      expect(h.setBackgrounded).toHaveBeenCalledOnce();
    } finally {
      h.stop();
    }
  });

  it("arms the grace for a tab that is bound while hidden", () => {
    const h = harness({ visible: false });
    try {
      vi.advanceTimersByTime(HOSTED_HIDDEN_GRACE_MS);
      expect(h.setBackgrounded).toHaveBeenCalledExactlyOnceWith(true);
      expect(h.suspend).not.toHaveBeenCalled();
    } finally {
      h.stop();
    }
  });

  it("clears the pending grace on disposal", () => {
    const h = harness();
    h.setVisible(false);
    expect(vi.getTimerCount()).toBe(1);
    h.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(HOSTED_HIDDEN_GRACE_MS * 2);
    expect(h.setBackgrounded).not.toHaveBeenCalled();
  });

  it("uses the injected timers and grace period", () => {
    const timers = {
      setTimeout: vi.fn((_callback: () => void, _ms: number) => "timer"),
      clearTimeout: vi.fn(),
    };
    const h = harness({ ports: { ...timers, hiddenGraceMs: 5_000 } });
    try {
      h.setVisible(false);
      expect(timers.setTimeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 5_000);
      h.setVisible(true);
      expect(timers.clearTimeout).toHaveBeenCalledExactlyOnceWith("timer");
    } finally {
      h.stop();
    }
  });
});
