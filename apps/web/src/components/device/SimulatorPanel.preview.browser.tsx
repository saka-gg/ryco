import "../../index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { create } from "zustand";
import {
  EnvironmentId,
  ThreadId,
  type DeviceDescriptor,
  type ThreadDeviceState,
} from "@ryco/contracts";
import { useDeviceStateStore } from "@ryco/client-runtime/state/device";
import SimulatorPanel from "./SimulatorPanel";
import { HOSTED_PREVIEW_IDLE_PAUSE_MS } from "./useDeviceScreenshotStream";
import { resetHostedPreviewLeaseForTests } from "./hostedPreviewLease";

// The panel runs with the real screenshot stream here, so its sampling pace, the
// idle pause and the resume paths are exercised through the rendered panel.

const mocks = vi.hoisted(() => ({
  hosted: true,
  screenshot: vi.fn(),
  keyEvent: vi.fn(),
  list: vi.fn(),
  getThreadState: vi.fn(),
}));
const hub = create(() => ({
  effectiveRole: "owner",
  directoryStatus: "ready",
  transportStatus: "online",
  browserStatus: "current",
  sessionStatus: "ready",
}));
vi.mock("../../composerDraftStore", () => ({ DraftId: { make: (value: string) => value } }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../../env", () => ({ isHostedHubMode: () => mocks.hosted }));
vi.mock("../../hostedHub/state", () => ({
  useHostedHubStore: (selector: (state: ReturnType<typeof hub.getState>) => unknown) =>
    hub(selector),
  hostedHubController: {
    acknowledgeDeliveryUnknown: vi.fn(),
    markEnvironmentDeliveryUnknown: vi.fn(),
  },
  getHostedEnvironmentSessions: () => ({
    read: () => undefined,
    getSnapshot: () => ({ records: new Map() }),
    subscribe: () => () => undefined,
  }),
}));
vi.mock("../../hostedHub/hostedConnectionCoordinator", () => ({
  useHostedWorkspaceState: () => ({ machines: [] }),
}));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: () => ({
    device: {
      list: mocks.list,
      getThreadState: mocks.getThreadState,
      screenshot: mocks.screenshot,
      keyEvent: mocks.keyEvent,
    },
  }),
}));
vi.mock("../../environments/runtime", () => ({ readEnvironmentConnection: () => undefined }));
vi.mock("./useDeviceVideoStream", () => ({
  useDeviceVideoStream: () => ({ status: "idle", error: null, dimensions: null }),
}));

const environmentId = EnvironmentId.make("preview-env");
const threadId = ThreadId.make("preview-thread");
const device: DeviceDescriptor = {
  udid: "AAAA-1111",
  platform: "ios-simulator",
  name: "iPhone",
  runtime: "iOS",
  state: "booted",
  bootSource: "user",
};
const snapshot: ThreadDeviceState = {
  threadId,
  version: 1,
  attachedDeviceUdid: device.udid,
  attachPhase: null,
  devices: [device],
  agentActive: false,
  availability: { kind: "available" },
  lastError: null,
};

const PAUSED_IDLE = "Preview paused — click to resume";

function pngBase64(): string {
  const image = document.createElement("canvas");
  image.width = 200;
  image.height = 400;
  image.getContext("2d")!.fillRect(0, 0, 200, 400);
  return image.toDataURL().split(",")[1]!;
}

const mountSized = () =>
  render(
    <div style={{ width: "min(600px, 100vw)", height: 700, display: "flex" }}>
      <SimulatorPanel environmentId={environmentId} threadId={threadId} />
    </div>,
  );

const captures = () => mocks.screenshot.mock.calls.length;
/** Fake-clock time of each capture, in order. */
const captureTimes: number[] = [];
// Lets React commit a status change and run the effects that follow it.
const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
/** Captures are at least one sampling interval apart. */
const expectPaced = () => {
  const gaps = captureTimes.slice(1).map((time, index) => time - captureTimes[index]!);
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(750);
};
/** Runs timers that are due now until `predicate` holds. */
const pollWhileDue = (predicate: () => boolean) =>
  expect
    .poll(async () => {
      await vi.advanceTimersByTimeAsync(0);
      return predicate();
    })
    .toBe(true);

beforeEach(() => {
  mocks.hosted = true;
  const png = pngBase64();
  captureTimes.length = 0;
  mocks.screenshot.mockReset().mockImplementation(async () => {
    captureTimes.push(Date.now());
    return {
      udid: device.udid,
      name: "screen.png",
      mimeType: "image/png",
      width: 200,
      height: 400,
      bytesBase64: png,
      capturedAt: new Date().toISOString(),
      sizeBytes: 100,
    };
  });
  mocks.keyEvent.mockReset().mockResolvedValue(undefined);
  // Keep panel refresh pending so the seeded snapshot stays in place.
  mocks.list.mockReset().mockImplementation(() => new Promise(() => {}));
  mocks.getThreadState.mockReset().mockImplementation(() => new Promise(() => {}));
  useDeviceStateStore.setState({
    environmentById: {},
    threadByKey: {},
    pendingOpenByThreadKey: {},
  });
  const store = useDeviceStateStore.getState();
  const generation = store.beginConnection(environmentId);
  store.applyThreadSnapshot(environmentId, generation, snapshot);
  resetHostedPreviewLeaseForTests();
  // Only the timers the preview schedules are faked; rendering keeps real time. Polling
  // advances the fake clock, so tests compare capture times rather than absolute offsets.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  resetHostedPreviewLeaseForTests();
});

describe("SimulatorPanel hosted preview", () => {
  it("keeps its sampling pace while the panel re-renders with each frame", async () => {
    const screen = await mountSized();
    await expect.element(screen.getByLabelText("iPhone screen")).toBeVisible();
    await pollWhileDue(() => captures() >= 1);
    await expect.poll(() => document.querySelector("canvas")?.width).toBe(200);
    await settle();

    // Each frame re-renders the panel. A sampler rebuilt by that would capture again
    // straight away instead of waiting out the interval.
    for (let step = 0; step < 24; step += 1) {
      await vi.advanceTimersByTimeAsync(250);
      await settle();
    }
    expect(captures()).toBeGreaterThanOrEqual(3);
    expectPaced();
  });

  it("pauses after the idle window and resumes from the overlay", async () => {
    const screen = await mountSized();
    await pollWhileDue(() => captures() >= 1);
    await expect.poll(() => document.querySelector("canvas")?.width).toBe(200);
    await settle();

    await vi.advanceTimersByTimeAsync(HOSTED_PREVIEW_IDLE_PAUSE_MS - 5_000);
    await expect.element(screen.getByText(PAUSED_IDLE)).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect.element(screen.getByText(PAUSED_IDLE)).toBeVisible();
    expectPaced();
    await settle();
    const frozen = captures();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(captures()).toBe(frozen);

    await screen.getByRole("button", { name: "Resume", exact: true }).click();
    await expect.element(screen.getByText(PAUSED_IDLE)).not.toBeInTheDocument();
    await pollWhileDue(() => captures() > frozen);
  });

  it("uses a key press on an idle-paused preview only to resume it", async () => {
    const screen = await mountSized();
    await pollWhileDue(() => captures() >= 1);
    await expect.poll(() => document.querySelector("canvas")?.width).toBe(200);
    await settle();
    await vi.advanceTimersByTimeAsync(HOSTED_PREVIEW_IDLE_PAUSE_MS);
    await expect.element(screen.getByText(PAUSED_IDLE)).toBeVisible();

    const canvas = document.querySelector("canvas")!;
    const init = { key: "ArrowDown", code: "ArrowDown", bubbles: true };
    canvas.dispatchEvent(new KeyboardEvent("keydown", init));
    canvas.dispatchEvent(new KeyboardEvent("keyup", init));
    await expect.element(screen.getByText(PAUSED_IDLE)).not.toBeInTheDocument();
    expect(mocks.keyEvent).not.toHaveBeenCalled();

    // The resumed preview forwards the next press.
    canvas.dispatchEvent(new KeyboardEvent("keydown", init));
    expect(mocks.keyEvent).toHaveBeenCalledTimes(1);
  });

  it("never idle-pauses a preview that is not hosted", async () => {
    mocks.hosted = false;
    const screen = await mountSized();
    await pollWhileDue(() => captures() >= 1);
    await expect.poll(() => document.querySelector("canvas")?.width).toBe(200);
    await settle();

    await vi.advanceTimersByTimeAsync(2 * HOSTED_PREVIEW_IDLE_PAUSE_MS);
    await settle();
    await expect.element(screen.getByText(PAUSED_IDLE)).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Resume", exact: true }))
      .not.toBeInTheDocument();
    const before = captures();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(captures()).toBeGreaterThan(before);
  });
});
