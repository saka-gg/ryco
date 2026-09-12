import { DeviceRpcError, DeviceTestingInput } from "@ryco/contracts";
import { Schema } from "effect";

interface TestingCommand {
  readonly label: string;
  readonly args: readonly string[];
  readonly stdin?: string;
}

function invalid(message: string): never {
  throw new DeviceRpcError({ code: "invalid-input", message, retryable: false });
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
      if (new TextEncoder().encode(action.payload).byteLength > 4096) {
        invalid("Push payload must be at most 4096 UTF-8 bytes.");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(action.payload);
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
      return [{ label: "push", args: ["push", udid, action.bundleId, "-"], stdin: action.payload }];
    }
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
