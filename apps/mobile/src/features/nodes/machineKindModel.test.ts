import type { ServerConfig } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { MACHINE_KIND_SYMBOL, resolveMachineKind } from "./machineKindModel";

const descriptor = (os: "darwin" | "linux" | "windows", machine?: "server" | null) => ({
  label: "node",
  platform: { os, arch: "arm64" as const, ...(machine === undefined ? {} : { machine }) },
});
const config = (
  environmentIcon: "workstation" | undefined,
  os: "darwin" | "linux" | "windows",
  machine?: "server" | null,
) =>
  ({
    settings: environmentIcon === undefined ? {} : { environmentIcon },
    environment: descriptor(os, machine),
  }) as unknown as Pick<ServerConfig, "settings" | "environment">;
const nothing = { config: null, descriptor: null, catalogKind: null } as const;

describe("machine kind symbols", () => {
  it("draws every kind with its own SF Symbol", () => {
    expect(MACHINE_KIND_SYMBOL).toEqual({
      laptop: "laptopcomputer",
      desktop: "desktopcomputer",
      "mini-pc": "macmini",
      workstation: "macpro.gen3",
      server: "server.rack",
      cloud: "cloud",
      linux: "terminal",
      windows: "pc",
    });
  });
});

describe("resolveMachineKind", () => {
  it("prefers the desktop's icon setting, then the machine hint, then its OS", () => {
    const resolve = (machineConfig: ReturnType<typeof config>) =>
      resolveMachineKind({ ...nothing, label: "Mac mini", config: machineConfig });
    expect(resolve(config("workstation", "darwin", "server"))).toBe("workstation");
    expect(resolve(config(undefined, "darwin", "server"))).toBe("server");
    expect(resolve(config(undefined, "linux"))).toBe("linux");
  });

  it("reads a disconnected direct machine's last descriptor", () => {
    expect(
      resolveMachineKind({ ...nothing, label: "Gaming PC", descriptor: descriptor("windows") }),
    ).toBe("windows");
  });

  it("lets the machine's own facts outrank the node catalog", () => {
    expect(
      resolveMachineKind({
        ...nothing,
        label: "Build box",
        descriptor: descriptor("linux", "server"),
        catalogKind: "cloud",
      }),
    ).toBe("server");
  });

  it("falls back to the node catalog, then a guess from the OS and name", () => {
    expect(resolveMachineKind({ ...nothing, label: "Ryco Cloud", catalogKind: "cloud" })).toBe(
      "cloud",
    );
    expect(resolveMachineKind({ ...nothing, label: "Mac mini M4" })).toBe("mini-pc");
    expect(resolveMachineKind({ ...nothing, label: "box", platformOs: "linux" })).toBe("linux");
    expect(resolveMachineKind({ ...nothing, label: "" })).toBe("server");
  });
});
