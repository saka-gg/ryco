import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));

import { endLiveActivities } from "./endLiveActivities";

describe("ending the Live Activity on the sign-in screen", () => {
  it("ends every Ryco card at once, also one still showing its results", async () => {
    const native = { dismissAgentActivities: vi.fn(async (_endedOnly: boolean) => undefined) };
    await endLiveActivities(native);
    expect(native.dismissAgentActivities.mock.calls).toEqual([[false]]);
  });

  it("does nothing in a build without the widget extension", async () => {
    await expect(endLiveActivities()).resolves.toBeUndefined();
  });
});
