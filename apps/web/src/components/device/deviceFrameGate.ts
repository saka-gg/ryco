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

/**
 * USB HID keyboard usage (page 7) for a physical key, by `KeyboardEvent.code`.
 *
 * Positions, not characters: the guest reads them with its own hardware
 * keyboard layout, as it does a real keyboard and Simulator.app, so a German
 * simulator types "z" for the key a German keyboard labels Z and "@" for
 * Option-L. Mapping characters instead would assume a US guest layout.
 * Caps Lock is left out: browsers report it as a toggle, not a key press.
 */
const HID_USAGE_BY_CODE: Readonly<Record<string, number>> = (() => {
  const table: Record<string, number> = {
    Enter: 0x28,
    NumpadEnter: 0x58,
    Escape: 0x29,
    Backspace: 0x2a,
    Tab: 0x2b,
    Space: 0x2c,
    Minus: 0x2d,
    Equal: 0x2e,
    BracketLeft: 0x2f,
    BracketRight: 0x30,
    Backslash: 0x31,
    IntlHash: 0x32,
    Semicolon: 0x33,
    Quote: 0x34,
    Backquote: 0x35,
    Comma: 0x36,
    Period: 0x37,
    Slash: 0x38,
    Insert: 0x49,
    Home: 0x4a,
    PageUp: 0x4b,
    Delete: 0x4c,
    End: 0x4d,
    PageDown: 0x4e,
    ArrowRight: 0x4f,
    ArrowLeft: 0x50,
    ArrowDown: 0x51,
    ArrowUp: 0x52,
    IntlBackslash: 0x64,
    IntlRo: 0x87,
    IntlYen: 0x89,
    ControlLeft: 0xe0,
    ShiftLeft: 0xe1,
    AltLeft: 0xe2,
    ControlRight: 0xe4,
    ShiftRight: 0xe5,
    AltRight: 0xe6,
  };
  for (let index = 0; index < 26; index += 1) {
    table[`Key${String.fromCharCode(65 + index)}`] = 0x04 + index;
  }
  for (let digit = 1; digit <= 9; digit += 1) table[`Digit${digit}`] = 0x1e + digit - 1;
  table.Digit0 = 0x27;
  for (let index = 1; index <= 12; index += 1) table[`F${index}`] = 0x3a + index - 1;
  return table;
})();

export function deviceHidUsageForCode(code: string): number | null {
  return HID_USAGE_BY_CODE[code] ?? null;
}
