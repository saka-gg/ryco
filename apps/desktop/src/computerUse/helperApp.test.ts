import { describe, expect, it } from "vitest";

import { computerUseHelperInfoPlist } from "@ryco/shared/computerUseHelperApp";

import { findComputerUseHelperApp, type HelperAppFileSystem } from "./helperApp.ts";
import { resolveComputerUsePermissionTarget } from "./permissionTarget.ts";

function fileSystem(files: Record<string, string>): HelperAppFileSystem {
  return {
    readDirectory: (path) => {
      const prefix = `${path}/`;
      const names = new Set(
        Object.keys(files)
          .filter((file) => file.startsWith(prefix))
          .map((file) => file.slice(prefix.length).split("/")[0]!),
      );
      if (names.size === 0) throw new Error("ENOENT");
      return [...names];
    },
    readFile: (path) => {
      const contents = files[path];
      if (contents === undefined) throw new Error("ENOENT");
      return Buffer.from(contents);
    },
  };
}

const plist = (name: string, bundleId: string) =>
  computerUseHelperInfoPlist({
    identity: { name, bundleId },
    version: "0.1.39",
    iconName: "AppIcon",
  });

const RYCO = "/Applications/Ryco.app";
const HELPER = `${RYCO}/Contents/Helpers/Ryco Computer Use.app`;

describe("findComputerUseHelperApp", () => {
  it("finds the packaged helper in Contents/Helpers by its protocol key", () => {
    const helper = findComputerUseHelperApp({
      hostBundlePath: RYCO,
      platform: "darwin",
      isPackaged: true,
      fileSystem: fileSystem({
        [`${HELPER}/Contents/Info.plist`]: plist(
          "Ryco Computer Use",
          "com.laurinfrank.ryco.computer-use",
        ),
      }),
    });
    expect(helper).toEqual({
      bundlePath: HELPER,
      bundleId: "com.laurinfrank.ryco.computer-use",
      displayName: "Ryco Computer Use",
      version: "0.1.39",
    });
  });

  it("finds the dev helper beside the launcher wrapper and skips other apps there", () => {
    const launchers =
      "/Users/me/Library/Application Support/Ryco Desktop Launchers/com.sak0a.ryco.dev";
    const helper = findComputerUseHelperApp({
      hostBundlePath: `${launchers}/Ryco (Dev).app`,
      platform: "darwin",
      isPackaged: false,
      fileSystem: fileSystem({
        [`${launchers}/Ryco (Dev).app/Contents/Info.plist`]:
          "<plist><dict><key>CFBundleIdentifier</key><string>com.sak0a.ryco.dev</string></dict></plist>",
        [`${launchers}/Other.app/Contents/Info.plist`]:
          "<plist><dict><key>RycoComputerUseProtocol</key><integer>999</integer></dict></plist>",
        [`${launchers}/Ryco Computer Use (Dev).app/Contents/Info.plist`]: plist(
          "Ryco Computer Use (Dev)",
          "com.sak0a.ryco.dev.computer-use",
        ),
      }),
    });
    expect(helper?.displayName).toBe("Ryco Computer Use (Dev)");
    expect(helper?.bundleId).toBe("com.sak0a.ryco.dev.computer-use");
  });

  it("never looks beside a packaged app, off macOS, or when turned off", () => {
    const files = fileSystem({
      "/Applications/Ryco Computer Use.app/Contents/Info.plist": plist("Ryco Computer Use", "x"),
    });
    expect(
      findComputerUseHelperApp({
        hostBundlePath: RYCO,
        platform: "darwin",
        isPackaged: true,
        fileSystem: files,
      }),
    ).toBeUndefined();
    expect(
      findComputerUseHelperApp({
        hostBundlePath: RYCO,
        platform: "linux",
        isPackaged: false,
        fileSystem: files,
      }),
    ).toBeUndefined();
    expect(
      findComputerUseHelperApp({
        hostBundlePath: "/Applications/Other/Ryco.app",
        platform: "darwin",
        isPackaged: false,
        env: { RYCO_COMPUTER_USE_HELPER_APP: "0" },
        fileSystem: fileSystem({
          "/Applications/Other/Helper.app/Contents/Info.plist": plist("Helper", "y"),
        }),
      }),
    ).toBeUndefined();
  });
});

describe("resolveComputerUsePermissionTarget", () => {
  it("gives the grants to Ryco Computer Use and keeps Ryco's windows excluded", () => {
    const helper = {
      bundlePath: HELPER,
      bundleId: "com.laurinfrank.ryco.computer-use",
      displayName: "Ryco Computer Use",
      version: "0.1.39",
    };
    const target = resolveComputerUsePermissionTarget({
      executablePath: `${RYCO}/Contents/MacOS/Ryco`,
      platform: "darwin",
      appName: "Ryco",
      isPackaged: true,
      findHelper: () => helper,
    });
    expect(target).toMatchObject({
      bundlePath: HELPER,
      bundleId: "com.laurinfrank.ryco.computer-use",
      displayName: "Ryco Computer Use",
      helper,
    });
    expect(target.hostBundleId).not.toBe(target.bundleId);
  });

  it("falls back to Ryco itself without a helper bundle", () => {
    const target = resolveComputerUsePermissionTarget({
      executablePath: "/usr/local/bin/ryco",
      platform: "darwin",
      appName: "Ryco",
      isPackaged: false,
      findHelper: () => undefined,
    });
    expect(target).toEqual({
      bundlePath: undefined,
      bundleId: target.hostBundleId,
      displayName: "Ryco",
      hostBundleId: target.hostBundleId,
      helper: undefined,
    });
  });
});
