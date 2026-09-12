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
}));
vi.mock("../../hostedHub/hostedConnectionCoordinator", () => ({
  useHostedWorkspaceState: () => workspace(),
}));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: () => ({
    device: { testing: mocks.testing, list: mocks.list, getThreadState: mocks.getThreadState },
  }),
}));
vi.mock("../../environments/runtime", () => ({ readEnvironmentConnection: () => undefined }));
vi.mock("./useDeviceVideoStream", () => ({
  useDeviceVideoStream: () => ({ status: "idle", error: null, dimensions: null }),
}));
vi.mock("./useDeviceScreenshotStream", () => ({
  useDeviceScreenshotStream: () => ({
    status: "streaming",
    error: null,
    dimensions: { width: 400, height: 800 },
  }),
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
