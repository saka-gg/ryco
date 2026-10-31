import type { DeviceDescriptor, DeviceUdid, ThreadDeviceState, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  devicePressInput,
  devicePreviewStatusText,
  deviceDriveAllowed,
  threadDevicePreview,
  viewPointToDevicePoint,
} from "./deviceViewerModel";

const udid = "sim-1" as DeviceUdid;
const iphone = {
  udid,
  name: "iPhone 16",
  platform: "ios-simulator",
  geometry: { scale: 3, pointWidth: 393, pointHeight: 852 },
} as unknown as DeviceDescriptor;

const state = (overrides: Partial<ThreadDeviceState> = {}): ThreadDeviceState =>
  ({
    threadId: "thread-1" as ThreadId,
    version: 1,
    attachedDeviceUdid: udid,
    attachPhase: null,
    devices: [iphone],
    agentActive: false,
    availability: { status: "available" },
    lastError: null,
    ...overrides,
  }) as unknown as ThreadDeviceState;

describe("threadDevicePreview", () => {
  it("names the device a thread has attached", () => {
    expect(threadDevicePreview(state({ agentActive: true }))).toMatchObject({
      udid,
      name: "iPhone 16",
      attaching: false,
      agentActive: true,
    });
    expect(threadDevicePreview(state({ attachPhase: "booting" } as never))?.attaching).toBe(true);
  });

  it("shows nothing without an attached device, and a generic name for an unlisted one", () => {
    expect(threadDevicePreview(state({ attachedDeviceUdid: null }))).toBeNull();
    expect(threadDevicePreview(undefined)).toBeNull();
    expect(threadDevicePreview(state({ devices: [] }))?.name).toBe("iOS Simulator");
  });
});

describe("deviceDriveAllowed", () => {
  it("lets only the node's owner drive, once the connection may change things", () => {
    expect(deviceDriveAllowed({ role: "owner", mutationReady: true })).toBe(true);
    expect(deviceDriveAllowed({ role: "operator", mutationReady: true })).toBe(false);
    expect(deviceDriveAllowed({ role: "viewer", mutationReady: true })).toBe(false);
    expect(deviceDriveAllowed({ role: "owner", mutationReady: false })).toBe(false);
    expect(deviceDriveAllowed({ mutationReady: true })).toBe(false);
    expect(deviceDriveAllowed(undefined)).toBe(false);
  });
});

describe("viewPointToDevicePoint and devicePressInput", () => {
  // A 1179×2556 px frame shown in a 390×600 view: contained at 600/2556 scale, centred.
  const layout = { viewWidth: 390, viewHeight: 600, frameWidth: 1179, frameHeight: 2556 };
  const shownWidth = 1179 * (600 / 2556);
  const left = (390 - shownWidth) / 2;

  it("maps a press inside the frame to device points and ignores the letterbox", () => {
    expect(viewPointToDevicePoint(iphone, layout, left + shownWidth / 2, 300)).toEqual({
      x: 197,
      y: 426,
    });
    expect(viewPointToDevicePoint(iphone, layout, left - 5, 300)).toBeNull();
  });

  it("sends a short press as a tap and a long one as a bounded swipe", () => {
    expect(
      devicePressInput({ udid, from: { x: 100, y: 100 }, to: { x: 104, y: 103 }, durationMs: 90 }),
    ).toEqual({ kind: "tap", input: { udid, x: 104, y: 103 } });
    expect(
      devicePressInput({ udid, from: { x: 100, y: 700 }, to: { x: 100, y: 200 }, durationMs: 5 }),
    ).toEqual({
      kind: "swipe",
      input: { udid, fromX: 100, fromY: 700, toX: 100, toY: 200, durationMs: 16 },
    });
    expect(devicePressInput({ udid, from: null, to: { x: 1, y: 1 }, durationMs: 50 })).toBeNull();
  });
});

describe("devicePreviewStatusText", () => {
  it("explains a paused or reconnecting preview, and says nothing while streaming", () => {
    expect(devicePreviewStatusText("paused-idle", null)).toContain("Touch the screen");
    expect(devicePreviewStatusText("recovering", "Socket closed")).toBe("Socket closed");
    expect(devicePreviewStatusText("streaming", null)).toBeNull();
  });
});
