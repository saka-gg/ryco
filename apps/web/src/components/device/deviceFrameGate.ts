// Adapted from Synara v0.7.2 (MIT); see THIRD_PARTY_NOTICES.md.
import type { DeviceFrameHeader, DeviceUdid } from "@ryco/contracts";

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

export {
  canvasPointToDevicePoint,
  type DevicePoint,
} from "@ryco/client-runtime/state/device/devicePoint";

export function deviceHidUsageForKey(key: string): number | null {
  const named: Readonly<Record<string, number>> = {
    Enter: 0x28,
    Escape: 0x29,
    Backspace: 0x2a,
    Tab: 0x2b,
    " ": 0x2c,
    ArrowRight: 0x4f,
    ArrowLeft: 0x50,
    ArrowDown: 0x51,
    ArrowUp: 0x52,
  };
  const lower = key.toLowerCase();
  if (lower >= "a" && lower <= "z" && lower.length === 1) {
    return 0x04 + lower.charCodeAt(0) - 97;
  }
  if (lower === "0") return 0x27;
  if (lower >= "1" && lower <= "9" && lower.length === 1) {
    return 0x1e + lower.charCodeAt(0) - 49;
  }
  return named[key] ?? null;
}
