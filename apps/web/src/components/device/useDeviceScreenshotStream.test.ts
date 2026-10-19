import type { DeviceScreenshotResult } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readHostedPreviewLeaseHolder,
  resetHostedPreviewLeaseForTests,
} from "./hostedPreviewLease";
import {
  createHostedPreviewSampler,
  HOSTED_PREVIEW_IDLE_PAUSE_MS,
  hostedScreenshotDelayMs,
  hostedScreenshotLoad,
  type HostedPreviewSampler,
  type HostedPreviewStatus,
} from "./useDeviceScreenshotStream";

describe("hosted screenshot fallback backpressure", () => {
  it("keeps tiny responses at the 750ms floor", () => {
    expect(hostedScreenshotDelayMs(1)).toBe(750);
  });

  it("paces the capacity assessment's measured full-PNG payloads", () => {
    expect(hostedScreenshotDelayMs(3_053_100)).toBe(5_824);
    expect(hostedScreenshotDelayMs(5_569_884)).toBe(10_624);
  });

  it("charges only the leased preview when several are visible", () => {
    expect(hostedScreenshotLoad(3_053_100, 1)).toEqual({
      intervalMs: 5_824,
      bytesPerSecondPerStream: 524_228,
      aggregateBytesPerSecond: 524_228,
    });
    expect(hostedScreenshotLoad(3_053_100, 2).aggregateBytesPerSecond).toBe(524_228);
    expect(hostedScreenshotLoad(3_053_100, 3).aggregateBytesPerSecond).toBe(524_228);
    expect(hostedScreenshotLoad(3_053_100, 0).aggregateBytesPerSecond).toBe(0);
  });

  it("caps a pathological response interval without removing backpressure", () => {
    expect(hostedScreenshotDelayMs(100 * 1024 * 1024)).toBe(15_000);
  });
});

function frame(): DeviceScreenshotResult {
  return {
    udid: "sim-1",
    name: "screen.png",
    mimeType: "image/png",
    width: 10,
    height: 20,
    sizeBytes: 750,
    bytesBase64: "A".repeat(1_000),
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("hosted preview sampler", () => {
  const samplers: HostedPreviewSampler[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const sampler of samplers.splice(0)) sampler.dispose();
    vi.useRealTimers();
    resetHostedPreviewLeaseForTests();
  });

  function start(
    ownerId: string,
    options: {
      readonly hosted?: boolean;
      readonly screenshot?: () => Promise<DeviceScreenshotResult>;
      readonly pageVisible?: boolean;
      readonly panelVisible?: boolean;
      readonly idleMs?: number;
    } = {},
  ) {
    const screenshot = vi.fn(options.screenshot ?? (async () => frame()));
    const paint = vi.fn(async (_shot: DeviceScreenshotResult, isCurrent: () => boolean) =>
      isCurrent(),
    );
    const statuses: HostedPreviewStatus[] = [];
    const errors: Array<string | null> = [];
    const sampler = createHostedPreviewSampler({
      ownerId,
      hosted: options.hosted ?? true,
      screenshot,
      paint,
      onStatus: (status) => statuses.push(status),
      onError: (message) => errors.push(message),
      pageVisible: options.pageVisible ?? true,
      panelVisible: options.panelVisible ?? true,
      ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
    });
    samplers.push(sampler);
    return { sampler, screenshot, paint, statuses, errors };
  }

  it("samples at the paced interval while visible and holding the lease", async () => {
    const preview = start("a");
    expect(preview.statuses).toEqual(["connecting"]);
    expect(readHostedPreviewLeaseHolder()).toBe("a");

    await vi.advanceTimersByTimeAsync(0);
    expect(preview.screenshot).toHaveBeenCalledTimes(1);
    expect(preview.statuses).toEqual(["connecting", "streaming"]);

    await vi.advanceTimersByTimeAsync(749);
    expect(preview.screenshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(preview.screenshot).toHaveBeenCalledTimes(2);
  });

  it("schedules no capture for a preview that does not hold the lease", async () => {
    const holder = start("a");
    holder.sampler.noteInteraction();
    const other = start("b");
    expect(other.statuses).toEqual(["paused-by-other-preview"]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(other.screenshot).not.toHaveBeenCalled();
    expect(holder.screenshot).toHaveBeenCalled();
    expect(readHostedPreviewLeaseHolder()).toBe("a");
  });

  it("moves sampling to the preview that was interacted with and back when it goes away", async () => {
    const first = start("a");
    const second = start("b");
    await vi.advanceTimersByTimeAsync(5_000);
    // Without interaction the newest preview holds the lease.
    expect(first.statuses.at(-1)).toBe("paused-by-other-preview");
    expect(first.screenshot).not.toHaveBeenCalled();
    expect(second.screenshot).toHaveBeenCalled();

    first.sampler.noteInteraction();
    expect(first.statuses.at(-1)).toBe("connecting");
    expect(second.statuses.at(-1)).toBe("paused-by-other-preview");
    const secondCalls = second.screenshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(second.screenshot).toHaveBeenCalledTimes(secondCalls);
    expect(first.screenshot).toHaveBeenCalled();
    expect(first.statuses.at(-1)).toBe("streaming");

    first.sampler.dispose();
    const resumed = second.screenshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(second.screenshot.mock.calls.length).toBeGreaterThan(resumed);
    expect(second.statuses.at(-1)).toBe("streaming");
  });

  it("samples at the rate of one preview when two are visible", async () => {
    const alone = start("solo");
    await vi.advanceTimersByTimeAsync(30_000);
    const singleRate = alone.screenshot.mock.calls.length;
    expect(singleRate).toBeGreaterThan(10);
    alone.sampler.dispose();

    const first = start("a");
    const second = start("b");
    second.sampler.noteInteraction();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first.screenshot.mock.calls.length + second.screenshot.mock.calls.length).toBe(
      singleRate,
    );
  });

  it("pauses after the idle window and resumes on interaction", async () => {
    const preview = start("a");
    await vi.advanceTimersByTimeAsync(HOSTED_PREVIEW_IDLE_PAUSE_MS - 1);
    expect(preview.statuses.at(-1)).toBe("streaming");
    expect(readHostedPreviewLeaseHolder()).toBe("a");

    await vi.advanceTimersByTimeAsync(1);
    expect(preview.statuses.at(-1)).toBe("paused-idle");
    expect(readHostedPreviewLeaseHolder()).toBeNull();
    const calls = preview.screenshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(preview.screenshot).toHaveBeenCalledTimes(calls);

    preview.sampler.noteInteraction();
    expect(readHostedPreviewLeaseHolder()).toBe("a");
    expect(preview.statuses.at(-1)).toBe("streaming");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(preview.screenshot.mock.calls.length).toBeGreaterThan(calls);

    await vi.advanceTimersByTimeAsync(HOSTED_PREVIEW_IDLE_PAUSE_MS);
    expect(preview.statuses.at(-1)).toBe("paused-idle");
  });

  it("restarts the idle window on every interaction", async () => {
    const preview = start("a");
    await vi.advanceTimersByTimeAsync(50_000);
    preview.sampler.noteInteraction();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(preview.statuses.at(-1)).toBe("streaming");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(preview.statuses.at(-1)).toBe("paused-idle");
  });

  it("lets an idle preview hand the lease to another visible one", async () => {
    const idle = start("a", { idleMs: 10_000 });
    idle.sampler.noteInteraction();
    const other = start("b", { idleMs: 10_000 });
    expect(other.statuses.at(-1)).toBe("paused-by-other-preview");

    // Waiting for the lease does not use up the idle window.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(other.statuses.at(-1)).toBe("paused-by-other-preview");
    await vi.advanceTimersByTimeAsync(1);
    expect(idle.statuses.at(-1)).toBe("paused-idle");
    expect(readHostedPreviewLeaseHolder()).toBe("b");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(other.screenshot).toHaveBeenCalled();
    expect(other.statuses.at(-1)).toBe("streaming");

    // Its own idle window starts when it takes over.
    await vi.advanceTimersByTimeAsync(7_999);
    expect(other.statuses.at(-1)).toBe("streaming");
    await vi.advanceTimersByTimeAsync(1);
    expect(other.statuses.at(-1)).toBe("paused-idle");
    expect(readHostedPreviewLeaseHolder()).toBeNull();
  });

  it.each([
    ["a", "b"],
    ["b", "a"],
  ])(
    "keeps the preview that was interacted with when the page is hidden and shown (%s first)",
    async (...order) => {
      const previews = { a: start("a"), b: start("b") };
      previews.a.sampler.noteInteraction();
      expect(readHostedPreviewLeaseHolder()).toBe("a");

      for (const id of order) previews[id as "a" | "b"].sampler.setPageVisible(false);
      expect(readHostedPreviewLeaseHolder()).toBeNull();
      for (const id of order) previews[id as "a" | "b"].sampler.setPageVisible(true);
      expect(readHostedPreviewLeaseHolder()).toBe("a");
      expect(previews.b.statuses.at(-1)).toBe("paused-by-other-preview");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(previews.b.screenshot).not.toHaveBeenCalled();
    },
  );

  it("does not lease or idle-pause a preview that is not hosted", async () => {
    const first = start("a", { hosted: false });
    const second = start("b", { hosted: false });
    expect(readHostedPreviewLeaseHolder()).toBeNull();
    expect(first.statuses).toEqual(["connecting"]);
    expect(second.statuses).toEqual(["connecting"]);

    await vi.advanceTimersByTimeAsync(2 * HOSTED_PREVIEW_IDLE_PAUSE_MS);
    expect(first.statuses.at(-1)).toBe("streaming");
    expect(second.statuses.at(-1)).toBe("streaming");
    expect(readHostedPreviewLeaseHolder()).toBeNull();
    // Both keep sampling at the paced interval after far more than the idle window.
    const calls = first.screenshot.mock.calls.length;
    expect(calls).toBeGreaterThan(100);
    expect(second.screenshot.mock.calls.length).toBe(calls);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(first.screenshot.mock.calls.length).toBe(calls + 2);

    // Interaction reports are ignored rather than creating a lease.
    first.sampler.noteInteraction();
    expect(readHostedPreviewLeaseHolder()).toBeNull();
    expect(first.statuses.at(-1)).toBe("streaming");
  });

  it("still suspends a preview that is not hosted while it is hidden", async () => {
    const preview = start("a", { hosted: false });
    await vi.advanceTimersByTimeAsync(2_000);
    preview.sampler.setPageVisible(false);
    const calls = preview.screenshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(preview.screenshot).toHaveBeenCalledTimes(calls);

    preview.sampler.setPageVisible(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(preview.screenshot.mock.calls.length).toBeGreaterThan(calls);
    preview.sampler.setPanelVisible(false);
    const hiddenCalls = preview.screenshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(preview.screenshot).toHaveBeenCalledTimes(hiddenCalls);
  });

  it("is not affected by hosted previews in the same tab", async () => {
    const hosted = start("a");
    hosted.sampler.noteInteraction();
    const direct = start("b", { hosted: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hosted.screenshot).toHaveBeenCalled();
    expect(direct.screenshot).toHaveBeenCalled();
    expect(direct.statuses.at(-1)).toBe("streaming");
    expect(readHostedPreviewLeaseHolder()).toBe("a");
  });

  it("stops and releases the lease while hidden, with a fresh idle window on return", async () => {
    const preview = start("a");
    await vi.advanceTimersByTimeAsync(2_000);
    preview.sampler.setPageVisible(false);
    expect(readHostedPreviewLeaseHolder()).toBeNull();
    const calls = preview.screenshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * HOSTED_PREVIEW_IDLE_PAUSE_MS);
    expect(preview.screenshot).toHaveBeenCalledTimes(calls);
    expect(preview.statuses.at(-1)).toBe("streaming");

    preview.sampler.setPageVisible(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(preview.screenshot.mock.calls.length).toBeGreaterThan(calls);

    preview.sampler.setPanelVisible(false);
    expect(readHostedPreviewLeaseHolder()).toBeNull();
    preview.sampler.setPanelVisible(true);
    expect(readHostedPreviewLeaseHolder()).toBe("a");
    await vi.advanceTimersByTimeAsync(HOSTED_PREVIEW_IDLE_PAUSE_MS - 1);
    expect(preview.statuses.at(-1)).toBe("streaming");
    await vi.advanceTimersByTimeAsync(1);
    expect(preview.statuses.at(-1)).toBe("paused-idle");
  });

  it("does not take the lease while its panel is not visible", async () => {
    const holder = start("a");
    holder.sampler.noteInteraction();
    const hidden = start("b", { panelVisible: false });
    expect(hidden.statuses).toEqual(["connecting"]);
    expect(readHostedPreviewLeaseHolder()).toBe("a");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(hidden.screenshot).not.toHaveBeenCalled();

    hidden.sampler.setPanelVisible(true);
    expect(hidden.statuses.at(-1)).toBe("paused-by-other-preview");
    expect(readHostedPreviewLeaseHolder()).toBe("a");
  });

  it("drops a frame that arrives after the preview stopped being current", async () => {
    let finish!: (shot: DeviceScreenshotResult) => void;
    const preview = start("a", {
      screenshot: () =>
        new Promise<DeviceScreenshotResult>((resolve) => {
          finish = resolve;
        }),
    });
    await vi.advanceTimersByTimeAsync(0);
    preview.sampler.setPageVisible(false);
    finish(frame());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(preview.paint).not.toHaveBeenCalled();
    expect(preview.statuses).toEqual(["connecting"]);
    expect(preview.screenshot).toHaveBeenCalledTimes(1);
  });

  it("reports a failed capture as recovering and keeps sampling", async () => {
    let attempts = 0;
    const preview = start("a", {
      screenshot: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("relay closed");
        return frame();
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(preview.statuses.at(-1)).toBe("recovering");
    expect(preview.errors).toEqual(["relay closed"]);

    await vi.advanceTimersByTimeAsync(750);
    expect(preview.statuses.at(-1)).toBe("streaming");
    expect(preview.errors.at(-1)).toBeNull();
  });

  it("stops sampling and frees the lease when disposed", async () => {
    const preview = start("a");
    await vi.advanceTimersByTimeAsync(2_000);
    preview.sampler.dispose();
    expect(readHostedPreviewLeaseHolder()).toBeNull();
    const calls = preview.screenshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * HOSTED_PREVIEW_IDLE_PAUSE_MS);
    expect(preview.screenshot).toHaveBeenCalledTimes(calls);
    expect(preview.statuses.at(-1)).not.toBe("paused-idle");
  });
});
