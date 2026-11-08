import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const linking = vi.hoisted(() => ({
  initial: null as string | null,
  registered: null as string | null,
  clear: vi.fn(),
}));
const platform = vi.hoisted(() => ({ OS: "ios" }));
vi.mock("react-native", () => ({ Platform: platform }));
vi.mock("expo-linking", () => ({
  getInitialURL: async () => linking.initial,
  getLinkingURL: () => linking.registered,
  clearInitialURL: linking.clear,
}));

import { forgetReceivedURL, readLaunchURL } from "./launchUrl";

beforeEach(() => {
  linking.initial = null;
  linking.registered = null;
  platform.OS = "ios";
  vi.clearAllMocks();
});

describe("launch URL", () => {
  it("prefers React Native's initial URL", async () => {
    linking.initial = "ryco://threads/a/b";
    linking.registered = "ryco://tasks/new";
    expect(await readLaunchURL({ consume: true })).toBe("ryco://threads/a/b");
    expect(linking.clear).not.toHaveBeenCalled();
  });

  it("reads the scene-delivered launch URL on iOS and consumes it once", async () => {
    linking.registered = "ryco-dev://threads/a/b";
    expect(await readLaunchURL({ consume: false })).toBe("ryco-dev://threads/a/b");
    expect(linking.clear).not.toHaveBeenCalled();
    expect(await readLaunchURL({ consume: true })).toBe("ryco-dev://threads/a/b");
    expect(linking.clear).toHaveBeenCalledOnce();
  });

  it("has no registry fallback elsewhere, and forgets received links on iOS only", async () => {
    platform.OS = "android";
    linking.registered = "ryco://tasks/new";
    expect(await readLaunchURL({ consume: true })).toBeNull();
    forgetReceivedURL();
    expect(linking.clear).not.toHaveBeenCalled();
    platform.OS = "ios";
    forgetReceivedURL();
    expect(linking.clear).toHaveBeenCalledOnce();
  });
});
