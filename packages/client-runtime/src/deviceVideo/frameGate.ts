// Adapted from Synara v0.7.2 (MIT); see THIRD_PARTY_NOTICES.md.
import type { DeviceFrameHeader, DeviceUdid } from "@ryco/contracts";

/**
 * Which frames a fresh H.264 decoder may take: codec configuration first, then
 * a keyframe, then the frames that follow it in sequence. A gap in the
 * sequence drops back to waiting for a keyframe and asks for one.
 */
export type DeviceFrameGatePhase = "awaiting-config" | "awaiting-keyframe" | "streaming";

export interface DeviceFrameGateState {
  readonly phase: DeviceFrameGatePhase;
  readonly lastSequence: number | null;
}

export type DeviceFrameGateAction =
  | { readonly kind: "configure" }
  | { readonly kind: "decode"; readonly keyframe: boolean }
  | { readonly kind: "drop" }
  | { readonly kind: "ignore" };

export function createDeviceFrameGateState(): DeviceFrameGateState {
  return { phase: "awaiting-config", lastSequence: null };
}

const SEQUENCE_MODULUS = 2 ** 32;
const MAX_PLAUSIBLE_SEQUENCE_GAP = 1_024;

export function stepDeviceFrameGate(
  state: DeviceFrameGateState,
  header: Pick<DeviceFrameHeader, "deviceId" | "sequence" | "keyframe" | "codecConfig">,
  expectedDeviceId: DeviceUdid,
): {
  readonly state: DeviceFrameGateState;
  readonly action: DeviceFrameGateAction;
  readonly requestKeyframe: boolean;
} {
  if (header.deviceId !== expectedDeviceId) {
    return { state, action: { kind: "ignore" }, requestKeyframe: false };
  }
  if (header.codecConfig) {
    return {
      state: { phase: "awaiting-keyframe", lastSequence: header.sequence },
      action: { kind: "configure" },
      requestKeyframe: false,
    };
  }
  if (state.phase === "awaiting-config") {
    return { state, action: { kind: "drop" }, requestKeyframe: false };
  }
  if (state.lastSequence !== null) {
    const distance = (header.sequence - state.lastSequence + SEQUENCE_MODULUS) % SEQUENCE_MODULUS;
    if (distance === 0 || distance > MAX_PLAUSIBLE_SEQUENCE_GAP) {
      return { state, action: { kind: "drop" }, requestKeyframe: false };
    }
    if (distance > 1 && !header.keyframe && state.phase === "streaming") {
      return {
        state: { phase: "awaiting-keyframe", lastSequence: header.sequence },
        action: { kind: "drop" },
        requestKeyframe: true,
      };
    }
  }
  if (state.phase === "awaiting-keyframe" && !header.keyframe) {
    return {
      state: { ...state, lastSequence: header.sequence },
      action: { kind: "drop" },
      requestKeyframe: false,
    };
  }
  return {
    state: { phase: "streaming", lastSequence: header.sequence },
    action: { kind: "decode", keyframe: header.keyframe },
    requestKeyframe: false,
  };
}
