/**
 * The phone's view of the simulator or emulator a thread's agent uses: which device the thread
 * has attached, whether this session may drive it, and what a press on the preview sends. Frames
 * and pacing come from `@ryco/client-runtime/state/device/previewSampler`, coordinates from
 * `.../devicePoint`; this module only decides. No React or React Native.
 *
 * @module deviceViewerModel
 */
import {
  canvasPointToDevicePoint,
  devicePointSize,
  type DevicePoint,
} from "@ryco/client-runtime/state/device/devicePoint";
import type {
  DeviceDescriptor,
  DeviceSwipeInput,
  DeviceTapInput,
  DeviceUdid,
  ThreadDeviceState,
} from "@ryco/contracts";
import { DEVICE_WS_METHODS } from "@ryco/contracts/device";

import { nodeRoleAllows } from "../../connection/nodeRoleAccess";
import type { InboxEnvironment } from "../inbox/inboxModel";

export interface ThreadDevicePreview {
  readonly udid: DeviceUdid;
  readonly name: string;
  readonly device: DeviceDescriptor | null;
  /** The attachment is still coming up. */
  readonly attaching: boolean;
  /** An agent tool is driving the device right now. */
  readonly agentActive: boolean;
}

/** The device a thread has attached, or null: the pill above the composer shows it. */
export function threadDevicePreview(
  state: ThreadDeviceState | null | undefined,
): ThreadDevicePreview | null {
  if (!state?.attachedDeviceUdid) return null;
  const device = state.devices.find((entry) => entry.udid === state.attachedDeviceUdid) ?? null;
  return {
    udid: state.attachedDeviceUdid,
    name:
      device?.name ??
      (device?.platform === "android-emulator" ? "Android Emulator" : "iOS Simulator"),
    device,
    attaching: (state.attachPhase ?? null) !== null,
    agentActive: state.agentActive,
  };
}

/**
 * Whether this session may drive the device, by the node's own rule for device input (the
 * owner) and the environment's shared mutation readiness. Others watch only.
 */
export function deviceDriveAllowed(
  environment: Pick<InboxEnvironment, "mutationReady" | "role"> | undefined,
): boolean {
  return (
    environment !== undefined &&
    environment.mutationReady === true &&
    environment.role !== undefined &&
    nodeRoleAllows(environment.role, DEVICE_WS_METHODS.input)
  );
}

/** A press shorter than this many device points is a tap; a longer one is a swipe (as on web). */
export const DEVICE_TAP_SLOP_POINTS = 8;

export interface DevicePreviewLayout {
  /** The preview view's size, in layout points. */
  readonly viewWidth: number;
  readonly viewHeight: number;
  /** The frame's size, in pixels. */
  readonly frameWidth: number;
  readonly frameHeight: number;
}

/** The device point under a view point, or null on the letterbox around the frame. */
export function viewPointToDevicePoint(
  device: DeviceDescriptor | null,
  layout: DevicePreviewLayout,
  viewX: number,
  viewY: number,
): DevicePoint | null {
  return canvasPointToDevicePoint(
    {
      frameWidth: layout.frameWidth,
      frameHeight: layout.frameHeight,
      displayWidth: layout.viewWidth,
      displayHeight: layout.viewHeight,
      ...devicePointSize(device, layout.frameWidth, layout.frameHeight),
    },
    viewX,
    viewY,
  );
}

/** What a press from `from` to `to` that lasted `durationMs` sends, or null when it missed the frame. */
export function devicePressInput(input: {
  readonly udid: DeviceUdid;
  readonly from: DevicePoint | null;
  readonly to: DevicePoint | null;
  readonly durationMs: number;
}):
  | { readonly kind: "tap"; readonly input: DeviceTapInput }
  | { readonly kind: "swipe"; readonly input: DeviceSwipeInput }
  | null {
  const { from, to, udid } = input;
  if (from === null || to === null) return null;
  if (Math.hypot(to.x - from.x, to.y - from.y) <= DEVICE_TAP_SLOP_POINTS)
    return { kind: "tap", input: { udid, x: to.x, y: to.y } };
  return {
    kind: "swipe",
    input: {
      udid,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      durationMs: Math.min(10_000, Math.max(16, Math.round(input.durationMs))),
    },
  };
}

/** What the viewer says about its frames (`HostedPreviewStatus`). */
export function devicePreviewStatusText(status: string, error: string | null): string | null {
  switch (status) {
    case "paused-idle":
      return "Paused to save data. Touch the screen to resume.";
    case "paused-by-other-preview":
      return "Another preview on this phone is showing.";
    case "connecting":
      return "Connecting…";
    case "recovering":
      return error ?? "Reconnecting…";
    default:
      return null;
  }
}
