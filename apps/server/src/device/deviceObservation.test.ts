import type { DeviceScreenshotResult, DeviceUiNode } from "@ryco/contracts";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  DEVICE_SETTLE_DEFAULTS,
  DEVICE_WAIT_MAX_MS,
  deviceActionContent,
  deviceEvidenceContent,
  observe,
  waitFor,
  waitForSettle,
  type DeviceObservation,
  type DeviceObservationClock,
  type DeviceObservationReader,
} from "./deviceObservation.ts";

const UDID = "SIM-0001";

function node(partial: Partial<DeviceUiNode> & { readonly role: string }): DeviceUiNode {
  return {
    subrole: null,
    label: null,
    value: null,
    frame: { x: 0, y: 0, width: 100, height: 40 },
    activationPoint: null,
    children: [],
    ...partial,
  };
}

const button = (label: string, y = 100, value: string | null = null) =>
  node({ role: "Button", label, value, frame: { x: 0, y, width: 200, height: 44 } });

const screen = (children: DeviceUiNode[], label: string | null = "Shop"): DeviceUiNode =>
  node({ role: "Application", label, frame: { x: 0, y: 0, width: 402, height: 874 }, children });

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A reader that answers each describe call from a script; an Error answer is a failed read. */
class ScriptedReader implements DeviceObservationReader {
  describeCalls = 0;
  screenshotCalls = 0;
  screenshotBase64 = PNG_1x1;
  screenshotSize = { width: 1, height: 1 };
  screenshotError: Error | null = null;

  private readonly script: (call: number) => DeviceUiNode | Error;

  constructor(script: (call: number) => DeviceUiNode | Error) {
    this.script = script;
  }

  async describeUi(udid: string) {
    const answer = this.script(this.describeCalls);
    this.describeCalls += 1;
    if (answer instanceof Error) throw answer;
    return { udid, capturedAt: new Date(0).toISOString(), root: answer };
  }

  async screenshot(udid: string): Promise<DeviceScreenshotResult> {
    this.screenshotCalls += 1;
    if (this.screenshotError) throw this.screenshotError;
    return {
      udid,
      name: "shot.png",
      mimeType: "image/png",
      ...this.screenshotSize,
      sizeBytes: Buffer.from(this.screenshotBase64, "base64").byteLength,
      bytesBase64: this.screenshotBase64,
      capturedAt: new Date(0).toISOString(),
    };
  }
}

/** Virtual time: every delay advances the clock by exactly its length, so deadlines are exact. */
function manualClock(): DeviceObservationClock & { readonly elapsed: () => number } {
  let now = 0;
  return {
    now: () => now,
    delay: async (ms, signal) => {
      signal?.throwIfAborted();
      now += ms;
      await Promise.resolve();
      signal?.throwIfAborted();
    },
    elapsed: () => now,
  };
}

async function noisePng(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#202020",
      noise: { type: "gaussian", mean: 128, sigma: 60 },
    },
  })
    .png()
    .toBuffer();
}

describe("waitForSettle", () => {
  it("returns once the tree holds still for the quiet window", async () => {
    const reader = new ScriptedReader(() => screen([button("Continue")]));
    const clock = manualClock();

    const outcome = await waitForSettle(reader, UDID, { clock });

    expect(outcome.settled).toBe(true);
    expect(outcome.settleSignal).toBe("accessibility");
    // Start delay, then reads every 100 ms until 300 ms have passed unchanged.
    expect(outcome.waitedMs).toBe(
      DEVICE_SETTLE_DEFAULTS.startDelayMs + DEVICE_SETTLE_DEFAULTS.quietMs,
    );
    expect(outcome.root?.label).toBe("Shop");
  });

  it("reports an endless animation as unsettled at the deadline instead of hanging", async () => {
    const reader = new ScriptedReader((call) => screen([button("Loading", 100, String(call))]));

    const outcome = await waitForSettle(reader, UDID, { clock: manualClock(), timeoutMs: 1_000 });

    expect(outcome.settled).toBe(false);
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(1_000);
    expect(outcome.waitedMs).toBeLessThan(1_200);
    expect(outcome.root).not.toBeNull();
  });

  it("gives up after the tree grace on a device without a tree, not at the deadline", async () => {
    const reader = new ScriptedReader(() => new Error("no accessibility"));

    const outcome = await waitForSettle(reader, UDID, { clock: manualClock() });

    expect(outcome).toMatchObject({ settled: null, root: null, settleSignal: "none" });
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(DEVICE_SETTLE_DEFAULTS.treeGraceMs);
    expect(outcome.waitedMs).toBeLessThan(
      DEVICE_SETTLE_DEFAULTS.treeGraceMs + DEVICE_SETTLE_DEFAULTS.pollMs + 1,
    );
    expect(outcome.waitedMs).toBeLessThan(DEVICE_SETTLE_DEFAULTS.timeoutMs);
  });

  it("settles a tree that answers after its first reads failed, as during an app swap", async () => {
    const reader = new ScriptedReader((call) =>
      call < 3 ? new Error("swapping apps") : screen([button("Inbox")], "Mail"),
    );

    const outcome = await waitForSettle(reader, UDID, { clock: manualClock() });

    expect(outcome).toMatchObject({ settled: true, settleSignal: "accessibility" });
    expect(outcome.root?.label).toBe("Mail");
  });

  it("says a short wait on a device without a tree found none, rather than unsettled", async () => {
    const reader = new ScriptedReader(() => new Error("no accessibility"));

    const outcome = await waitForSettle(reader, UDID, { clock: manualClock(), timeoutMs: 300 });

    expect(outcome).toMatchObject({ settled: null, root: null, settleSignal: "none" });
    expect(outcome.waitedMs).toBeLessThan(400);
  });

  it("treats a failed read as a transition when the tree is known", async () => {
    const reader = new ScriptedReader((call) =>
      call < 2 ? new Error("swapping apps") : screen([button("Inbox")], "Mail"),
    );

    const outcome = await waitForSettle(reader, UDID, { clock: manualClock(), treeKnown: true });

    expect(outcome.settled).toBe(true);
    expect(outcome.root?.label).toBe("Mail");
  });
});

describe("observe", () => {
  it("says an action changed nothing after waiting out the change grace", async () => {
    const reader = new ScriptedReader(() => screen([button("Continue")]));
    let acted = false;

    const observation = await observe(
      reader,
      UDID,
      async () => {
        acted = true;
      },
      { clock: manualClock() },
    );

    expect(acted).toBe(true);
    expect(observation.changed).toBe(false);
    expect(observation.settled).toBe(true);
    expect(observation.waitedMs).toBeGreaterThanOrEqual(DEVICE_SETTLE_DEFAULTS.changeGraceMs);
  });

  it("waits for an effect that starts after a pause instead of settling on the old screen", async () => {
    let changeAt = Number.POSITIVE_INFINITY;
    const reader = new ScriptedReader((call) =>
      call >= changeAt ? screen([], "Home Screen") : screen([button("Continue")]),
    );

    // The press lands, but the screen only starts moving five reads (about
    // half a second) later: longer than one quiet window.
    const observation = await observe(
      reader,
      UDID,
      async () => {
        changeAt = reader.describeCalls + 5;
      },
      { clock: manualClock() },
    );

    expect(observation.changed).toBe(true);
    expect(observation.settled).toBe(true);
    expect(observation.root?.label).toBe("Home Screen");
  });

  it("waits for a different app to come to the front after a launch", async () => {
    let launchedAt = Number.POSITIVE_INFINITY;
    const reader = new ScriptedReader((call) => {
      if (call < launchedAt) return screen([button("Continue")], "Shop");
      // The blank transition between apps holds still and must not count.
      if (call < launchedAt + 4) return screen([], " ");
      return screen([button("Inbox")], "Mail");
    });

    const observation = await observe(
      reader,
      UDID,
      async () => {
        launchedAt = reader.describeCalls;
      },
      { clock: manualClock(), awaitApp: "different", timeoutMs: 6_000 },
    );

    expect(observation.settled).toBe(true);
    expect(observation.changed).toBe(true);
    expect(observation.root?.label).toBe("Mail");
  });

  it("reports unsettled when the launched app never replaces the one in front", async () => {
    const reader = new ScriptedReader(() => screen([button("Continue")], "Shop"));
    const clock = manualClock();

    const observation = await observe(reader, UDID, async () => {}, {
      clock,
      awaitApp: "different",
      timing: { appChangeTimeoutMs: 2_000 },
    });

    expect(observation).toMatchObject({ settled: false, changed: null });
    expect(observation.root?.label).toBe("Shop");
    expect(observation.waitedMs).toBeGreaterThanOrEqual(2_000);
  });

  it("with awaitChange, reports a screen that never changes as unsettled at the timeout", async () => {
    const still = new ScriptedReader(() => screen([button("Continue")]));
    let openedAt = Number.POSITIVE_INFINITY;
    const opened = new ScriptedReader((call) =>
      call >= openedAt ? screen([button("Article")], "Safari") : screen([button("Continue")]),
    );

    const unchanged = await observe(still, UDID, async () => {}, {
      clock: manualClock(),
      awaitChange: true,
      timeoutMs: 3_000,
    });
    const changed = await observe(
      opened,
      UDID,
      async () => {
        openedAt = opened.describeCalls + 12;
      },
      { clock: manualClock(), awaitChange: true, timeoutMs: 3_000 },
    );

    expect(unchanged).toMatchObject({ settled: false, changed: false });
    expect(unchanged.waitedMs).toBeGreaterThanOrEqual(3_000);
    // Past the 1 s change grace a plain observe would already have given up.
    expect(changed).toMatchObject({ settled: true, changed: true });
    expect(changed.root?.label).toBe("Safari");
  });

  it("acts once and hands back after one short pause when the device has no tree", async () => {
    const reader = new ScriptedReader(() => new Error("Android has no accessibility tree"));
    const clock = manualClock();
    let actions = 0;

    const observation = await observe(
      reader,
      UDID,
      async () => {
        actions += 1;
      },
      { clock },
    );

    expect(actions).toBe(1);
    // One start delay plus one quiet window, not the 2.5 s settle deadline.
    expect(observation).toEqual({
      settled: null,
      waitedMs: DEVICE_SETTLE_DEFAULTS.startDelayMs + DEVICE_SETTLE_DEFAULTS.quietMs,
      changed: null,
      root: null,
      settleSignal: "none",
    });
    // The read before the action, then one every poll until the pause ends.
    expect(reader.describeCalls).toBe(5);
  });

  it("settles as usual when only the read before the action failed", async () => {
    const reader = new ScriptedReader((call) =>
      call === 0 ? new Error("swapping apps") : screen([button("Inbox")], "Mail"),
    );

    const observation = await observe(reader, UDID, async () => {}, { clock: manualClock() });

    // A tree after the action: settled and shown, but with nothing to compare against.
    expect(observation).toMatchObject({
      settled: true,
      changed: null,
      settleSignal: "accessibility",
    });
    expect(observation.root?.label).toBe("Mail");
  });

  it("stops promptly when its signal aborts mid-settle", async () => {
    const controller = new AbortController();
    const reader = new ScriptedReader((call) => {
      if (call === 3) controller.abort();
      return screen([button("Loading", 100, String(call))]);
    });

    await expect(
      observe(reader, UDID, async () => {}, { clock: manualClock(), signal: controller.signal }),
    ).rejects.toThrow();
    expect(reader.describeCalls).toBe(4);
  });

  it("aborts a real-time delay without waiting for it", async () => {
    const controller = new AbortController();
    const reader = new ScriptedReader(() => screen([button("Continue")]));
    const started = performance.now();
    setTimeout(() => controller.abort(), 20);

    await expect(
      waitForSettle(reader, UDID, {
        signal: controller.signal,
        timing: { startDelayMs: 10_000 },
        timeoutMs: 20_000,
      }),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(reader.describeCalls).toBe(0);
  });
});

describe("waitFor", () => {
  it("returns as soon as the element is on screen", async () => {
    const reader = new ScriptedReader(() => screen([button("Continue")]));

    const outcome = await waitFor(
      reader,
      UDID,
      { label: "Continue" },
      { timeoutMs: 5_000, clock: manualClock() },
    );

    expect(outcome).toMatchObject({ status: "ready", waitedMs: 0 });
    expect(outcome.root?.label).toBe("Shop");
  });

  it("waits for an element to go away", async () => {
    const reader = new ScriptedReader((call) =>
      screen(call < 3 ? [button("Loading"), button("Back", 200)] : [button("Back", 200)]),
    );

    const outcome = await waitFor(
      reader,
      UDID,
      { label: "Loading" },
      { gone: true, timeoutMs: 5_000, clock: manualClock() },
    );

    expect(outcome.status).toBe("ready");
    expect(outcome.waitedMs).toBe(600);
  });

  it("treats several matches as present, and as still there for gone", async () => {
    const reader = new ScriptedReader(() => screen([button("Item", 100), button("Item", 200)]));

    const present = await waitFor(
      reader,
      UDID,
      { label: "Item" },
      { timeoutMs: 1_000, clock: manualClock() },
    );
    const gone = await waitFor(
      reader,
      UDID,
      { label: "Item" },
      { gone: true, timeoutMs: 1_000, clock: manualClock() },
    );

    expect(present.status).toBe("ambiguous");
    expect(gone.status).toBe("timeout");
  });

  it("times out on an element that never appears, or only appears off screen", async () => {
    const reader = new ScriptedReader(() => screen([button("Far", 3_000)]));

    const outcome = await waitFor(
      reader,
      UDID,
      { label: "Far" },
      { timeoutMs: 1_000, clock: manualClock() },
    );

    expect(outcome.status).toBe("timeout");
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(1_000);
    expect(outcome.waitedMs).toBeLessThan(1_400);
  });

  it("clamps an oversized timeout to the wait maximum", async () => {
    const reader = new ScriptedReader(() => screen([]));

    const outcome = await waitFor(
      reader,
      UDID,
      { label: "Never" },
      { timeoutMs: 120_000, clock: manualClock() },
    );

    expect(outcome.status).toBe("timeout");
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(DEVICE_WAIT_MAX_MS);
    expect(outcome.waitedMs).toBeLessThan(DEVICE_WAIT_MAX_MS + 400);
  });

  it("refuses a device whose tree never answers within the grace", async () => {
    const reader = new ScriptedReader(() => new Error("no tree"));
    const clock = manualClock();

    await expect(
      waitFor(reader, UDID, { label: "Continue" }, { timeoutMs: 5_000, clock }),
    ).rejects.toThrow(/wait needs the accessibility tree/);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(DEVICE_SETTLE_DEFAULTS.treeGraceMs);
    expect(clock.elapsed()).toBeLessThan(DEVICE_SETTLE_DEFAULTS.treeGraceMs + 200);
  });

  it("keeps waiting through reads that fail while apps swap", async () => {
    const reader = new ScriptedReader((call) =>
      call < 2 ? new Error("swapping apps") : screen([button("Login")], "Mail"),
    );

    const outcome = await waitFor(
      reader,
      UDID,
      { label: "Login" },
      { timeoutMs: 5_000, clock: manualClock() },
    );

    expect(outcome).toMatchObject({ status: "ready", waitedMs: 400 });
    expect(outcome.root?.label).toBe("Mail");
  });

  it("times out without a tree when the wait is shorter than the grace", async () => {
    const reader = new ScriptedReader(() => new Error("no tree"));

    const outcome = await waitFor(
      reader,
      UDID,
      { label: "Continue" },
      { timeoutMs: 400, clock: manualClock() },
    );

    expect(outcome).toMatchObject({ status: "timeout", root: null });
  });
});

describe("deviceEvidenceContent", () => {
  const settledOn = (root: DeviceUiNode | null): DeviceObservation => ({
    settled: root === null ? null : true,
    waitedMs: 420.4,
    changed: root === null ? null : true,
    root,
    settleSignal: root === null ? "none" : "accessibility",
  });

  it("returns the JSON metadata then the snapshot, with no image for a device with a tree", async () => {
    const reader = new ScriptedReader(() => screen([]));

    const content = await deviceEvidenceContent(
      reader,
      UDID,
      settledOn(screen([button("Continue")])),
      { udid: UDID, x: 1, y: 2 },
      { screenshot: "no-tree", maxImageBase64Chars: 1_000_000 },
    );

    expect(content.map((block) => block.type)).toEqual(["text", "text"]);
    expect(JSON.parse((content[0] as { text: string }).text)).toEqual({
      udid: UDID,
      x: 1,
      y: 2,
      settled: true,
      waitedMs: 420,
      screenChanged: true,
      settleSignal: "accessibility",
      screenPoints: { width: 402, height: 874 },
      screenshot: "skipped",
    });
    expect((content[1] as { text: string }).text).toContain('- Button "Continue"');
    expect(reader.screenshotCalls).toBe(0);
  });

  it("attaches one screenshot automatically when the device gave no tree", async () => {
    const reader = new ScriptedReader(() => screen([]));

    const content = await deviceEvidenceContent(
      reader,
      UDID,
      settledOn(null),
      { udid: UDID },
      { screenshot: "no-tree", maxImageBase64Chars: 1_000_000 },
    );

    expect(content.map((block) => block.type)).toEqual(["text", "image"]);
    expect(content[1]).toEqual({ type: "image", data: PNG_1x1, mimeType: "image/png" });
    const metadata = JSON.parse((content[0] as { text: string }).text);
    expect(metadata).toMatchObject({
      settled: null,
      screenChanged: null,
      screenshot: "attached",
      screenshotPixels: { width: 1, height: 1 },
    });
    expect(metadata).not.toHaveProperty("screenPoints");
    expect(reader.screenshotCalls).toBe(1);
  });

  it("never attaches a screenshot when told not to", async () => {
    const reader = new ScriptedReader(() => screen([]));

    const content = await deviceEvidenceContent(
      reader,
      UDID,
      settledOn(null),
      {},
      {
        screenshot: "never",
        maxImageBase64Chars: 1_000_000,
      },
    );

    expect(content.map((block) => block.type)).toEqual(["text"]);
    expect(reader.screenshotCalls).toBe(0);
  });

  it("fits a large screenshot to the transport's budget as a JPEG", async () => {
    const reader = new ScriptedReader(() => screen([]));
    reader.screenshotBase64 = (await noisePng(1_000, 1_000)).toString("base64");
    reader.screenshotSize = { width: 1_000, height: 1_000 };
    expect(reader.screenshotBase64.length).toBeGreaterThan(3_000_000);

    const content = await deviceEvidenceContent(
      reader,
      UDID,
      settledOn(screen([button("Continue")])),
      {},
      { screenshot: "always", maxImageBase64Chars: 360_000 },
    );

    expect(content.map((block) => block.type)).toEqual(["text", "text", "image"]);
    const image = content[2] as { data: string; mimeType: string };
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.data.length).toBeLessThanOrEqual(360_000);
    const metadata = JSON.parse((content[0] as { text: string }).text);
    expect(metadata.screenshot).toMatch(
      /^attached: scaled from 1000x1000 to \d+x\d+ JPEG to fit this transport$/,
    );
    // The capture's own size: what positions on the smaller image stand for.
    expect(metadata.screenshotPixels).toEqual({ width: 1_000, height: 1_000 });
    expect(reader.screenshotCalls).toBe(1);
  });

  it("reports an image the fitter cannot fit as omitted", async () => {
    const reader = new ScriptedReader(() => screen([]));
    reader.screenshotBase64 = Buffer.from("not a png".repeat(100)).toString("base64");

    const content = await deviceEvidenceContent(
      reader,
      UDID,
      settledOn(null),
      {},
      {
        screenshot: "always",
        maxImageBase64Chars: 100,
      },
    );

    expect(content.map((block) => block.type)).toEqual(["text"]);
    expect(JSON.parse((content[0] as { text: string }).text).screenshot).toBe(
      "omitted: too large for this transport",
    );
  });

  it("reports a failed screenshot without failing the action", async () => {
    const reader = new ScriptedReader(() => screen([]));
    reader.screenshotError = new Error("simctl io screenshot failed");

    const content = await deviceEvidenceContent(
      reader,
      UDID,
      settledOn(null),
      { udid: UDID },
      {
        screenshot: "no-tree",
        maxImageBase64Chars: 1_000_000,
      },
    );

    expect(content.map((block) => block.type)).toEqual(["text"]);
    expect(JSON.parse((content[0] as { text: string }).text).screenshot).toBe(
      "unavailable: simctl io screenshot failed",
    );
  });
});

describe("deviceActionContent", () => {
  it("returns only the action's fields unless a screenshot was asked for", async () => {
    const reader = new ScriptedReader(() => screen([]));

    const plain = await deviceActionContent(
      reader,
      UDID,
      { udid: UDID, x: 1, y: 2 },
      {
        screenshot: false,
        maxImageBase64Chars: 1_000_000,
      },
    );
    const shot = await deviceActionContent(
      reader,
      UDID,
      { udid: UDID, x: 1, y: 2 },
      {
        screenshot: true,
        maxImageBase64Chars: 1_000_000,
      },
    );

    expect(plain).toEqual([
      { type: "text", text: JSON.stringify({ udid: UDID, x: 1, y: 2 }, null, 2) },
    ]);
    expect(shot.map((block) => block.type)).toEqual(["text", "image"]);
    // Nothing was measured, so there are no settle flags to misread.
    expect(JSON.parse((shot[0] as { text: string }).text)).toEqual({
      udid: UDID,
      x: 1,
      y: 2,
      screenshot: "attached",
      screenshotPixels: { width: 1, height: 1 },
    });
    expect(reader.describeCalls).toBe(0);
    expect(reader.screenshotCalls).toBe(1);
  });
});
