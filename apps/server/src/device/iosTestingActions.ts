import { DeviceRpcError, DeviceTestingInput } from "@ryco/contracts";
import { Schema } from "effect";

interface TestingCommand {
  readonly label: string;
  /**
   * `simctl` arguments, or with `simSettings` the arguments of Ryco's own
   * `ryco-sim-settings` tool, which the backend runs inside the simulator.
   */
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly simSettings?: true;
}

/** `ryco-sim-settings` keys for the switches `simctl ui` does not cover. */
const SIM_SETTINGS_KEYS = {
  "reduce-motion": "reduce-motion",
  "reduce-transparency": "reduce-transparency",
  "show-borders": "show-borders",
  voiceover: "voiceover",
} as const;

function invalid(message: string): never {
  throw new DeviceRpcError({ code: "invalid-input", message, retryable: false });
}

function validatePushPayload(text: string): void {
  if (new TextEncoder().encode(text).byteLength > 4096) {
    invalid("Push payload must be at most 4096 UTF-8 bytes.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    invalid("Push payload must be valid JSON.");
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("aps" in payload) ||
    typeof payload.aps !== "object" ||
    payload.aps === null ||
    Array.isArray(payload.aps)
  ) {
    invalid("Push payload must be a JSON object containing an aps object.");
  }
}

/**
 * The checks every platform shares, past the schema: what an agent can fix in
 * its own arguments. Whether a platform supports the action is its backend's call.
 */
export function validateDeviceTestingInput(input: DeviceTestingInput): void {
  if (!Schema.is(DeviceTestingInput)(input)) invalid("Invalid simulator testing action.");
  if (input.action.type === "push") validatePushPayload(input.action.payload);
}

/** Pure validation/planning, before discovery or execution. No shell interpolation. */
export function planIosTestingAction(input: DeviceTestingInput): readonly TestingCommand[] {
  if (!Schema.is(DeviceTestingInput)(input)) invalid("Invalid simulator testing action.");
  const { udid, action } = input;
  const ui = (option: string, value: string): TestingCommand => ({
    label: option,
    args: ["ui", udid, option, value],
  });
  switch (action.type) {
    case "appearance":
      return [ui("appearance", action.value)];
    case "text-size":
      return [ui("content_size", action.value)];
    case "location":
      return [
        {
          label: "location",
          args: ["location", udid, "set", `${action.latitude},${action.longitude}`],
        },
      ];
    case "clear-location":
      return [{ label: "clear location", args: ["location", udid, "clear"] }];
    case "permission":
      return [
        {
          label: "permission",
          args: ["privacy", udid, action.decision, action.service, action.bundleId],
        },
      ];
    case "push": {
      validatePushPayload(action.payload);
      return [{ label: "push", args: ["push", udid, action.bundleId, "-"], stdin: action.payload }];
    }
    case "orientation":
      return invalid(
        "Orientation is an Android emulator setting; rotate an iOS simulator with the rotate button.",
      );
    case "network":
      return invalid("Network on/off is an Android emulator setting.");
    case "accessibility":
      if (action.setting === "increase-contrast") {
        return [ui("increase_contrast", action.value ? "enabled" : "disabled")];
      }
      return [
        {
          label: action.setting,
          args: ["set", SIM_SETTINGS_KEYS[action.setting], action.value ? "on" : "off"],
          simSettings: true,
        },
      ];
    case "liquid-glass":
      return [
        { label: "Liquid Glass", args: ["set", "liquid-glass", action.value], simSettings: true },
      ];
    case "color-filter":
      return [
        { label: "color filter", args: ["set", "color-filter", action.value], simSettings: true },
      ];
    case "terminate-app":
      return [{ label: "terminate", args: ["terminate", udid, action.bundleId] }];
    case "preset":
      switch (action.value) {
        case "dark":
          return [ui("appearance", "dark")];
        case "large-text":
          return [ui("content_size", "accessibility-large")];
        case "dark-large-text":
          return [ui("appearance", "dark"), ui("content_size", "accessibility-large")];
        case "standard":
          return [ui("appearance", "light"), ui("content_size", "large")];
      }
  }
}
