import { describe, expect, it, vi } from "vite-plus/test";

import { bindHostedBrowserLifecycle } from "./browserLifecycle";

function harness() {
  const document = new EventTarget();
  const window = new EventTarget();
  let visible = true;
  let online = true;
  const suspend = vi.fn();
  const recover = vi.fn(async (): Promise<void> => undefined);
  const setBackgrounded = vi.fn(async () => undefined);
  const stop = bindHostedBrowserLifecycle({
    document,
    window,
    isVisible: () => visible,
    isOnline: () => online,
    suspend,
    recover,
    setBackgrounded,
  });
  return {
    document,
    window,
    suspend,
    recover,
    setBackgrounded,
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
