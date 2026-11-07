import { describe, expect, it, vi } from "vite-plus/test";

import { registerThreadDismissal, withThreadDismissal } from "./threadDismissal";

describe("thread dismissal", () => {
  it("waits for every visible copy before changing thread state", async () => {
    const inbox = Promise.withResolvers<void>();
    const project = Promise.withResolvers<void>();
    const restore = vi.fn();
    const unregisterInbox = registerThreadDismissal("env:thread", () => ({
      finished: inbox.promise,
      restore,
    }));
    const unregisterProject = registerThreadDismissal("env:thread", () => ({
      finished: project.promise,
      restore,
    }));
    const command = vi.fn(async () => true);
    try {
      const result = withThreadDismissal("env:thread", command, Boolean);
      expect(command).not.toHaveBeenCalled();
      inbox.resolve();
      await inbox.promise;
      expect(command).not.toHaveBeenCalled();
      project.resolve();
      expect(await result).toBe(true);
      expect(command).toHaveBeenCalledOnce();
      expect(restore).not.toHaveBeenCalled();
    } finally {
      unregisterInbox();
      unregisterProject();
    }
  });

  it.each([false, "throw"])(
    "restores dismissed rows when the command returns %s",
    async (outcome) => {
      const restore = vi.fn();
      const unregister = registerThreadDismissal("env:thread", () => ({
        finished: Promise.resolve(),
        restore,
      }));
      try {
        const result = withThreadDismissal(
          "env:thread",
          async () => {
            if (outcome === "throw") throw new Error("Disconnected");
            return outcome;
          },
          Boolean,
        );
        if (outcome === "throw") await expect(result).rejects.toThrow("Disconnected");
        else expect(await result).toBe(false);
        expect(restore).toHaveBeenCalledOnce();
      } finally {
        unregister();
      }
    },
  );

  it("tells the rows when the command succeeded, and never restores them itself", async () => {
    const restore = vi.fn();
    const committed = vi.fn();
    const unregister = registerThreadDismissal("env:thread", () => ({
      finished: Promise.resolve(),
      restore,
      committed,
    }));
    try {
      await withThreadDismissal("env:thread", async () => true, Boolean);
      expect(committed).toHaveBeenCalledOnce();
      expect(restore).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("runs the command at once when no row shows the thread", async () => {
    const command = vi.fn(async () => "done");
    expect(await withThreadDismissal("env:other", command, () => true)).toBe("done");
    expect(command).toHaveBeenCalledOnce();
  });
});
