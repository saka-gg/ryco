import "../../index.css";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
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

const mocks = vi.hoisted(() => ({
  hosted: false,
  previewStatus: "streaming" as string,
  noteInteraction: vi.fn(),
  streamInput: vi.fn(),
  keyEvent: vi.fn(),
  testing: vi.fn<() => Promise<void>>(),
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
const workspace = create(() => ({
  machines: [{ environmentId: "simulator-env", canMutate: true }],
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
}));
vi.mock("../../hostedHub/hostedConnectionCoordinator", () => ({
  useHostedWorkspaceState: () => workspace(),
}));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: () => ({
    device: {
      testing: mocks.testing,
      list: mocks.list,
      getThreadState: mocks.getThreadState,
      keyEvent: mocks.keyEvent,
    },
  }),
}));
vi.mock("../../environments/runtime", () => ({ readEnvironmentConnection: () => undefined }));
vi.mock("./useDeviceVideoStream", () => ({
  useDeviceVideoStream: () => ({ status: "idle", error: null, dimensions: null }),
}));
vi.mock("./useDeviceScreenshotStream", () => ({
  useDeviceScreenshotStream: (input: unknown) => {
    mocks.streamInput(input);
    return {
      status: mocks.previewStatus,
      error: null,
      dimensions: { width: 400, height: 800 },
      noteInteraction: mocks.noteInteraction,
    };
  },
}));

const environmentId = EnvironmentId.make("simulator-env");
const threadId = ThreadId.make("simulator-thread");
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

beforeEach(() => {
  mocks.hosted = false;
  mocks.previewStatus = "streaming";
  mocks.noteInteraction.mockReset();
  mocks.streamInput.mockReset();
  mocks.keyEvent.mockReset().mockResolvedValue(undefined);
  mocks.testing.mockReset().mockResolvedValue(undefined);
  // Keep panel refresh pending so only the real store's explicit connection
  // transitions below publish readiness; cached snapshots remain in place.
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
  hub.setState({
    effectiveRole: "owner",
    directoryStatus: "ready",
    transportStatus: "online",
    browserStatus: "current",
    sessionStatus: "ready",
  });
  workspace.setState({ machines: [{ environmentId, canMutate: true }] });
});

describe("SimulatorPanel testing readiness", () => {
  it("shows the SSH testing limitation instead of offering unsupported controls", async () => {
    const remote = {
      ...device,
      udid: "ssh:mac:AAAA-1111",
      host: { id: "mac", name: "Mac", transport: "ssh" as const },
    };
    const store = useDeviceStateStore.getState();
    const generation = store.environmentById[environmentId]!.generation;
    store.applyInventory(environmentId, generation, [remote], { kind: "available" });
    store.applyThreadSnapshot(environmentId, generation, {
      ...snapshot,
      version: 2,
      attachedDeviceUdid: remote.udid,
      devices: [remote],
    });
    const screen = await render(
      <SimulatorPanel environmentId={environmentId} threadId={threadId} />,
    );
    await expect
      .element(screen.getByText("Simulator testing controls are unavailable on SSH hosts."))
      .toBeVisible();
    await expect
      .element(screen.getByText("Simulator testing", { exact: true }))
      .not.toBeInTheDocument();
    expect(mocks.testing).not.toHaveBeenCalled();
  });

  it("disables cached attached devices through reconnect/error until current connection inventory arrives", async () => {
    const screen = await render(
      <SimulatorPanel environmentId={environmentId} threadId={threadId} />,
    );
    await screen.getByText("Simulator testing", { exact: true }).click();
    const dark = screen.getByRole("button", { name: "Dark mode", exact: true });
    await expect.element(dark).toBeEnabled();
    const store = useDeviceStateStore.getState();
    const previousGeneration = store.environmentById[environmentId]!.generation;
    const generation = store.beginConnection(environmentId);
    await screen.getByText("Simulator testing", { exact: true }).click();
    await expect.element(dark).toBeDisabled();
    expect(useDeviceStateStore.getState().environmentById[environmentId]!.devices).toEqual([
      device,
    ]);
    expect(Object.values(useDeviceStateStore.getState().threadByKey)[0]?.attachedDeviceUdid).toBe(
      device.udid,
    );
    store.applyInventory(environmentId, previousGeneration, [device], { kind: "available" });
    await expect.element(dark).toBeDisabled();
    store.markConnectionError(environmentId, generation, "Disconnected");
    await expect.element(dark).toBeDisabled();
    expect(mocks.testing).not.toHaveBeenCalled();
    store.applyInventory(environmentId, generation, [device], { kind: "available" });
    await expect.element(dark).toBeEnabled();
    await dark.click();
    expect(mocks.testing).toHaveBeenCalledExactlyOnceWith({
      udid: device.udid,
      action: { type: "preset", value: "dark" },
    });
  });

  it("uses shared hosted authorization and current-shell mutation readiness despite connected device snapshots", async () => {
    mocks.hosted = true;
    const screen = await render(
      <SimulatorPanel environmentId={environmentId} threadId={threadId} />,
    );
    await screen.getByText("Simulator testing", { exact: true }).click();
    const dark = screen.getByRole("button", { name: "Dark mode", exact: true });
    await expect.element(dark).toBeEnabled();
    hub.setState({ transportStatus: "connecting" });
    await expect.element(dark).toBeDisabled();
    workspace.setState({ machines: [{ environmentId, canMutate: false }] });
    hub.setState({ transportStatus: "online" });
    await expect.element(dark).toBeDisabled();
    workspace.setState({ machines: [{ environmentId, canMutate: true }] });
    hub.setState({ effectiveRole: "viewer" });
    await expect.element(dark).toBeDisabled();
    hub.setState({ effectiveRole: "owner", browserStatus: "stale" });
    await expect.element(dark).toBeDisabled();
    hub.setState({ browserStatus: "current" });
    await expect.element(dark).toBeEnabled();
    expect(mocks.testing).not.toHaveBeenCalled();
  });
});

describe("SimulatorPanel hosted preview pause", () => {
  // The device frame needs a definite box before its screen can be hit-tested.
  const mountSized = () =>
    render(
      <div style={{ width: "min(600px, 100vw)", height: 700, display: "flex" }}>
        <SimulatorPanel environmentId={environmentId} threadId={threadId} />
      </div>,
    );

  it("shows no pause overlay while the preview is streaming", async () => {
    const screen = await mountSized();
    await expect.element(screen.getByLabelText("iPhone screen")).toBeVisible();
    await expect.element(screen.getByText(/Preview paused/)).not.toBeInTheDocument();
  });

  it.each([
    ["paused-by-other-preview", "Preview paused — another preview is active"],
    ["paused-idle", "Preview paused — click to resume"],
  ])("explains a %s preview and resumes it from the overlay", async (status, message) => {
    mocks.previewStatus = status;
    const screen = await mountSized();
    await expect.element(screen.getByText(message)).toBeVisible();
    const resume = screen.getByRole("button", { name: "Resume", exact: true });
    await expect.element(resume).toBeVisible();
    mocks.noteInteraction.mockClear();
    // A plain click sends no pointer or key events, so only the button itself can report this.
    (resume.element() as HTMLElement).click();
    expect(mocks.noteInteraction).toHaveBeenCalledTimes(1);
  });

  it.each([[true], [false]])(
    "marks the preview as hosted only in the hosted app (hosted: %s)",
    async (hosted) => {
      mocks.hosted = hosted;
      const screen = await mountSized();
      await expect.element(screen.getByLabelText("iPhone screen")).toBeVisible();
      expect(mocks.streamInput).toHaveBeenLastCalledWith(expect.objectContaining({ hosted }));
    },
  );

  const pressKey = (key: string) => {
    const canvas = document.querySelector("canvas")!;
    const init = { key, code: key, bubbles: true };
    canvas.dispatchEvent(new KeyboardEvent("keydown", init));
    canvas.dispatchEvent(new KeyboardEvent("keyup", init));
  };

  it("forwards key presses to the device while the preview is live", async () => {
    const screen = await mountSized();
    await expect.element(screen.getByLabelText("iPhone screen")).toBeVisible();
    pressKey("ArrowDown");
    expect(mocks.keyEvent.mock.calls.map(([input]) => input.direction)).toEqual(["down", "up"]);
  });

  it.each(["paused-idle", "paused-by-other-preview"])(
    "uses a key press on a %s preview only to resume it",
    async (status) => {
      mocks.previewStatus = status;
      const screen = await mountSized();
      await expect.element(screen.getByLabelText("iPhone screen")).toBeVisible();
      pressKey("ArrowDown");
      expect(mocks.noteInteraction).toHaveBeenCalledTimes(1);
      expect(mocks.keyEvent).not.toHaveBeenCalled();

      // Once the preview is live again the same key is forwarded.
      mocks.previewStatus = "streaming";
      await screen.rerender(
        <div style={{ width: "min(600px, 100vw)", height: 700, display: "flex" }}>
          <SimulatorPanel environmentId={environmentId} threadId={threadId} />
        </div>,
      );
      pressKey("ArrowDown");
      expect(mocks.keyEvent).toHaveBeenCalledTimes(2);
    },
  );

  it("reports pointer and keyboard activity in the panel as interaction", async () => {
    const screen = await mountSized();
    await expect.element(screen.getByLabelText("iPhone screen")).toBeVisible();
    expect(mocks.noteInteraction).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Refresh simulators", exact: true }).click();
    expect(mocks.noteInteraction).toHaveBeenCalledTimes(1);
    document
      .querySelector("select")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(mocks.noteInteraction).toHaveBeenCalledTimes(2);
  });
});
