import { describe, expect, it } from "vite-plus/test";

import { assertDesktopBuildArch, desktopBuildArch } from "./native-build-cache.mjs";

describe("desktop native build architecture", () => {
  const appleSilicon = /Apple Silicon \(arm64\) only/;

  it("builds macOS helpers for Apple Silicon only", () => {
    for (const development of [false, true]) {
      expect(
        desktopBuildArch({ development, platform: "darwin", hostArch: "arm64", env: {} }),
      ).toBe("arm64");
    }
    // Packaging from an Intel host still targets the arm64 app.
    expect(desktopBuildArch({ platform: "darwin", hostArch: "x64", env: {} })).toBe("arm64");
  });

  it.each([
    { env: { RYCO_DESKTOP_ARCH: "x64" }, hostArch: "arm64", development: false },
    { env: { RYCO_DESKTOP_ARCH: "universal" }, hostArch: "arm64", development: false },
    { env: { RYCO_DESKTOP_ARCH: "universal" }, hostArch: "arm64", development: true },
    // An Intel or Rosetta Node cannot load arm64 helpers into its local Electron.
    { env: {}, hostArch: "x64", development: true },
  ])("refuses an Intel or universal macOS request: %j", (options) => {
    expect(() => desktopBuildArch({ ...options, platform: "darwin" })).toThrow(appleSilicon);
  });

  it.each(["linux", "win32"])("keeps x64 and arm64 on %s", (platform) => {
    for (const hostArch of ["x64", "arm64"]) {
      expect(desktopBuildArch({ platform, hostArch, env: {} })).toBe(hostArch);
      expect(desktopBuildArch({ development: true, platform, hostArch, env: {} })).toBe(hostArch);
    }
    expect(
      desktopBuildArch({ platform, hostArch: "arm64", env: { RYCO_DESKTOP_ARCH: "x64" } }),
    ).toBe("x64");
    expect(() => assertDesktopBuildArch("universal", platform)).toThrow("expected arm64 or x64");
  });
});
