import { describe, expect, it, vi } from "vitest";

import type { AndroidCommand } from "./AndroidEmulatorBackend.ts";
import { LazyAndroidEmulatorBackend } from "./LazyAndroidEmulatorBackend.ts";

describe("LazyAndroidEmulatorBackend", () => {
  it("loads the adapter on the first Android call and forwards to that one instance", async () => {
    const run = vi.fn<AndroidCommand>(async (_command, args) =>
      Buffer.from(args[0] === "-list-avds" ? "Pixel_Test\n" : "List of devices attached\n"),
    );
    const backend = new LazyAndroidEmulatorBackend({
      env: {},
      home: "/nonexistent-android-test",
      run,
      scrcpy: null,
      uiHelper: null,
    });
    expect(backend.geometry("android:Pixel_Test")).toBeNull();
    expect(backend.previewMode("android:Pixel_Test")).toBeNull();
    expect(run).not.toHaveBeenCalled();
    await expect(backend.listDevices({ includeShutdown: true })).resolves.toMatchObject([
      { udid: "android:Pixel_Test", state: "shutdown" },
    ]);
    await expect(backend.listDevices({ includeShutdown: true })).resolves.toHaveLength(1);
    await backend.detachStream("android:Pixel_Test");
    await backend.dispose();
    await expect(backend.tap("android:Pixel_Test", 1, 1)).rejects.toThrow("disposed");
  });
});
