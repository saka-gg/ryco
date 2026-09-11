import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, DEFAULT_SERVER_SETTINGS, type ServerConfig } from "@ryco/contracts";
import { inferEnvironmentMachineKind, resolveEnvironmentMachineKind } from "./environmentIcon.ts";

const environment: ServerConfig["environment"] = {
  environmentId: EnvironmentId.make("node-a"),
  label: "MacBook Pro von Laurin",
  platform: { os: "darwin", arch: "arm64", machine: "laptop" },
  serverVersion: "1",
  capabilities: {
    repositoryIdentity: false,
    threadPriorityRanking: false,
    threadSettlement: false,
  },
};
describe("device icons", () => {
  it.each([
    ["darwin", "MacBook Pro von Laurin", "laptop"],
    ["darwin", "Mac mini", "mini-pc"],
    ["darwin", "Mac Studio", "workstation"],
    ["linux", "workstation", "workstation"],
    ["linux", "WSL", "linux"],
    ["windows", "host", "windows"],
    [undefined, "host", "server"],
  ] as const)("infers %s / %s without probing the machine", (os, name, expected) =>
    expect(inferEnvironmentMachineKind(os, name)).toBe(expected),
  );
  it("prioritizes the owner's choice and restores the detected icon with Automatic", () => {
    const config = {
      environment,
      settings: { ...DEFAULT_SERVER_SETTINGS, environmentIcon: "cloud" as const },
    };
    expect(resolveEnvironmentMachineKind(config)).toBe("cloud");
    expect(
      resolveEnvironmentMachineKind({
        ...config,
        settings: { ...config.settings, environmentIcon: null },
      }),
    ).toBe("laptop");
  });
  it("supports older nodes without machine hints and absent configs", () => {
    expect(
      resolveEnvironmentMachineKind(null, {
        ...environment,
        platform: { os: "linux", arch: "x64" },
        label: "remote",
      }),
    ).toBe("linux");
    expect(resolveEnvironmentMachineKind()).toBe("server");
  });
});
