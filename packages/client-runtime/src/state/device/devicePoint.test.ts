import { describe, expect, it } from "vite-plus/test";

import { devicePointSize } from "./devicePoint.ts";

describe("devicePointSize", () => {
  it("maps Android video smaller than the display back to display pixels", () => {
    const device = {
      platform: "android-emulator" as const,
      geometry: { pointWidth: 1080, pointHeight: 2280, scale: 1 },
    };
    expect(devicePointSize(device, 758, 1600)).toEqual({ pointWidth: 1080, pointHeight: 2280 });
    // Rotated frames before the rotated descriptor arrives.
    expect(devicePointSize(device, 1600, 758)).toEqual({ pointWidth: 2280, pointHeight: 1080 });
  });

  it("keeps Android screenshots in their own pixels without geometry, and iOS in points", () => {
    expect(devicePointSize({ platform: "android-emulator" }, 1080, 2280)).toEqual({
      pointWidth: 1080,
      pointHeight: 2280,
    });
    expect(
      devicePointSize(
        { platform: "ios-simulator", geometry: { pointWidth: 402, pointHeight: 874, scale: 3 } },
        1206,
        2622,
      ),
    ).toEqual({ pointWidth: 402, pointHeight: 874 });
  });
});
