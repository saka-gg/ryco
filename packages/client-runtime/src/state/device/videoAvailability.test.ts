import { describe, expect, it } from "vitest";

import { deviceVideoStreamAvailable } from "./videoAvailability.ts";

const ios = { platform: "ios-simulator" as const };
const android = { platform: "android-emulator" as const };
const direct = { openFrameSource: () => undefined };
const hosted = { openFrameSource: () => undefined, frameSourceNeedsRelayTunnel: true as const };

describe("deviceVideoStreamAvailable", () => {
  it("needs a frame source and a device", () => {
    expect(deviceVideoStreamAvailable(null, null, ios)).toBe(false);
    expect(deviceVideoStreamAvailable({}, null, ios)).toBe(false);
    expect(deviceVideoStreamAvailable(direct, null, null)).toBe(false);
    expect(deviceVideoStreamAvailable(direct, null, ios)).toBe(true);
  });

  it("streams a hosted device only from a node that advertises the relay frame tunnel", () => {
    expect(deviceVideoStreamAvailable(hosted, {}, ios)).toBe(false);
    expect(deviceVideoStreamAvailable(hosted, null, ios)).toBe(false);
    expect(deviceVideoStreamAvailable(hosted, { relayFrameTunnel: 1 }, ios)).toBe(true);
    expect(deviceVideoStreamAvailable(hosted, { relayFrameTunnel: 2 }, ios)).toBe(true);
  });

  it("streams Android only once its backend says video runs", () => {
    expect(deviceVideoStreamAvailable(direct, null, android)).toBe(false);
    expect(deviceVideoStreamAvailable(direct, null, { ...android, preview: "screenshots" })).toBe(
      false,
    );
    expect(deviceVideoStreamAvailable(direct, null, { ...android, preview: "video" })).toBe(true);
  });
});
