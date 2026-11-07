import type { DeviceUiNode } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  alertPushPayload,
  flattenUiFrames,
  formatCoordinate,
  isBundleId,
  parseCoordinates,
} from "./deviceTools.logic";

const node = (frame: DeviceUiNode["frame"], children: DeviceUiNode[] = []): DeviceUiNode => ({
  role: "Other",
  subrole: null,
  label: null,
  value: null,
  frame,
  activationPoint: null,
  children,
});

describe("Tools drawer logic", () => {
  it("outlines each distinct sized element below the root", () => {
    const button = { x: 10, y: 10, width: 50, height: 20 };
    const root = node({ x: 0, y: 0, width: 400, height: 800 }, [
      node(button, [node(button)]),
      node({ x: 0, y: 0, width: 0, height: 0 }),
      node({ x: 5, y: 40, width: 30, height: 30 }),
    ]);
    expect(flattenUiFrames(root)).toEqual([button, { x: 5, y: 40, width: 30, height: 30 }]);
  });

  it("builds an alert push payload with an aps object", () => {
    expect(JSON.parse(alertPushPayload('Say "hi"'))).toEqual({
      aps: { alert: 'Say "hi"', sound: "default" },
    });
  });

  it("accepts coordinate pairs in range only", () => {
    expect(parseCoordinates("37.33", "-122.0")).toEqual({ latitude: 37.33, longitude: -122 });
    expect(parseCoordinates("91", "0")).toBeNull();
    expect(parseCoordinates("", "0")).toBeNull();
    expect(parseCoordinates("a", "0")).toBeNull();
  });

  it("checks bundle ids and formats coordinates", () => {
    expect(isBundleId("com.example.app")).toBe(true);
    expect(isBundleId("bad id")).toBe(false);
    expect(formatCoordinate(37.3349)).toBe("37.3349");
    expect(formatCoordinate(-122.009)).toBe("-122.009");
  });
});
