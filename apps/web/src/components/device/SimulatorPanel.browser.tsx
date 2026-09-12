import "../../index.css";
import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import {
  EnvironmentId,
  ThreadId,
  type DeviceDescriptor,
  type ThreadDeviceState,
} from "@ryco/contracts";
import { useDeviceStateStore } from "@ryco/client-runtime/state/device";
import SimulatorPanel from "./SimulatorPanel";

vi.mock("../../composerDraftStore", () => ({ DraftId: { make: (value: string) => value } }));

const mocks = vi.hoisted(() => ({
  api: {
    list: vi.fn(),
    getThreadState: vi.fn(),
    screenshot: vi.fn(),
    typeText: vi.fn(),
    keyEvent: vi.fn(),
    tap: vi.fn(),
    swipe: vi.fn(),
    pressButton: vi.fn(),
    attach: vi.fn(),
  },
  nativeVideo: vi.fn(),
  openFrameSource: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../../environmentApi", () => ({ readEnvironmentApi: () => ({ device: mocks.api }) }));
vi.mock("../../environments/runtime", () => ({
  readEnvironmentConnection: () => ({
    client: { device: { openFrameSource: mocks.openFrameSource } },
  }),
}));
vi.mock("./useDeviceVideoStream", () => ({ useDeviceVideoStream: mocks.nativeVideo }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

const environmentId = EnvironmentId.make("android-browser-test");
const threadId = ThreadId.make("android-thread");
const android: DeviceDescriptor = {
  platform: "android-emulator",
  udid: "android:Pixel",
  name: "Pixel",
  runtime: "Android",
  state: "booted",
  bootSource: "user",
  geometry: { pointWidth: 200, pointHeight: 400, scale: 1 },
};
let snapshot: ThreadDeviceState;
let generation = 0;
function updateAttachment(udid: string | null) {
  snapshot = { ...snapshot, version: snapshot.version + 1, attachedDeviceUdid: udid };
  useDeviceStateStore.getState().applyThreadSnapshot(environmentId, generation, snapshot);
}
async function mount() {
  return render(
    <div style={{ width: 600, height: 700, display: "flex" }}>
      <SimulatorPanel environmentId={environmentId} threadId={threadId} />
    </div>,
  );
}
function sendKey(key: string) {
  const canvas = document.querySelector("canvas")!;
  canvas.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  canvas.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
}
beforeEach(() => {
  vi.clearAllMocks();
  useDeviceStateStore.setState({ environmentById: {}, threadByKey: {} });
  generation = useDeviceStateStore.getState().beginConnection(environmentId);
  snapshot = {
    threadId,
    version: 1,
    attachedDeviceUdid: android.udid,
    attachPhase: null,
    devices: [android],
    agentActive: false,
    availability: { kind: "available" },
    lastError: null,
  };
  useDeviceStateStore
    .getState()
    .applyInventory(environmentId, generation, snapshot.devices, snapshot.availability);
  useDeviceStateStore.getState().applyThreadSnapshot(environmentId, generation, snapshot);
  mocks.api.list.mockImplementation(async () => ({
    devices: snapshot.devices,
    availability: snapshot.availability,
  }));
  mocks.api.getThreadState.mockImplementation(async () => snapshot);
  mocks.api.attach.mockImplementation(async ({ udid }) => ({
    ...snapshot,
    version: snapshot.version + 1,
    attachedDeviceUdid: udid,
  }));
  for (const method of [
    mocks.api.typeText,
    mocks.api.keyEvent,
    mocks.api.tap,
    mocks.api.swipe,
    mocks.api.pressButton,
  ])
    method.mockResolvedValue(undefined);
  mocks.nativeVideo.mockReturnValue({ status: "idle", error: null, dimensions: null });
  const image = document.createElement("canvas");
  image.width = 200;
  image.height = 400;
  image.getContext("2d")!.fillRect(0, 0, 200, 400);
  mocks.api.screenshot.mockResolvedValue({
    udid: android.udid,
    name: "screen.png",
    mimeType: "image/png",
    width: 200,
    height: 400,
    bytesBase64: image.toDataURL().split(",")[1],
    capturedAt: new Date().toISOString(),
    sizeBytes: 100,
  });
});

describe("Android simulator pane", () => {
  it("renders the PNG preview, maps pixel input, and exposes Android buttons", async () => {
    await mount();
    await expect.poll(() => document.querySelector("canvas")?.width).toBe(200);
    expect(mocks.nativeVideo.mock.calls.at(-1)?.[0].udid).toBeNull();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    expect(mocks.api.pressButton).toHaveBeenCalledWith({ udid: android.udid, button: "back" });
    await page.getByRole("button", { name: "Recents", exact: true }).click();
    expect(mocks.api.pressButton).toHaveBeenCalledWith({ udid: android.udid, button: "recents" });
    await expect
      .element(page.getByRole("button", { name: "Record screen", exact: true }))
      .toBeDisabled();
    await page.getByLabelText("Pixel screen").click();
    const point = mocks.api.tap.mock.calls.at(-1)?.[0];
    expect(point.udid).toBe(android.udid);
    expect(point.x).toBeCloseTo(100, 0);
    expect(point.y).toBeCloseTo(200, 0);
  });
  it("preserves a,b,Backspace,Enter while the first RPC is delayed", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.api.typeText.mockImplementationOnce(() => pending);
    await mount();
    sendKey("a");
    sendKey("b");
    sendKey("Backspace");
    sendKey("Enter");
    await expect.poll(() => mocks.api.typeText.mock.calls.length).toBe(1);
    expect(mocks.api.keyEvent).not.toHaveBeenCalled();
    release();
    await expect.poll(() => mocks.api.keyEvent.mock.calls.length).toBe(2);
    expect(mocks.api.typeText.mock.calls.map(([input]) => input.text)).toEqual(["a", "b"]);
    expect(mocks.api.keyEvent.mock.calls.map(([input]) => input.keyCode)).toEqual([42, 40]);
    expect(mocks.api.keyEvent.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.api.typeText.mock.invocationCallOrder[1]!,
    );
  });
  it.each(["detach", "reconnect"])("drops pending keyboard input after %s", async (change) => {
    let release!: () => void;
    mocks.api.typeText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await mount();
    sendKey("a");
    sendKey("b");
    sendKey("Backspace");
    await expect.poll(() => mocks.api.typeText.mock.calls.length).toBe(1);
    if (change === "detach") updateAttachment(null);
    else useDeviceStateStore.getState().beginConnection(environmentId);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mocks.api.typeText).toHaveBeenCalledTimes(1);
    expect(mocks.api.keyEvent).not.toHaveBeenCalled();
  });
  it("cancels the queued suffix on a targeting failure until reattachment", async () => {
    let fail!: (error: Error) => void;
    mocks.api.typeText.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    await mount();
    sendKey("a");
    sendKey("b");
    sendKey("Backspace");
    sendKey("Enter");
    await expect.poll(() => mocks.api.typeText.mock.calls.length).toBe(1);
    fail(new Error("Android keyboard transport changed; queued input cancelled."));
    await expect.poll(() => mocks.toast.mock.calls.length).toBe(1);
    sendKey("c");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mocks.api.typeText).toHaveBeenCalledTimes(1);
    expect(mocks.api.keyEvent).not.toHaveBeenCalled();
    updateAttachment(null);
    await expect.element(page.getByRole("combobox")).toBeVisible();
    updateAttachment(android.udid);
    await expect.element(page.getByLabelText("Pixel screen")).toBeVisible();
    sendKey("d");
    await expect.poll(() => mocks.api.typeText.mock.calls.length).toBe(2);
    expect(mocks.api.typeText.mock.calls[1]?.[0].text).toBe("d");
  });
  it("keeps the iOS picker accessible when only its helper build remains", async () => {
    snapshot = {
      ...snapshot,
      attachedDeviceUdid: null,
      devices: [{ ...android, platform: "ios-simulator", udid: "IOS-1", name: "iPhone" }],
      availability: {
        kind: "setup-required",
        steps: [{ id: "build-device-helper", label: "Build helper", done: false }],
      },
    };
    useDeviceStateStore
      .getState()
      .applyInventory(environmentId, generation, snapshot.devices, snapshot.availability);
    updateAttachment(null);
    await mount();
    await page.getByRole("combobox").selectOptions("IOS-1");
    await expect.poll(() => mocks.api.attach.mock.calls.length).toBe(1);
    expect(mocks.api.attach).toHaveBeenCalledWith({ threadId, udid: "IOS-1" });
  });
});
