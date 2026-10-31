import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  createUnsignedMacUpdateInstallScript,
  parseMacCodeSignatureKind,
  resolveMacAppBundlePath,
  resolveMacUpdateTargetAppPath,
  shouldUseUnsignedMacUpdateInstaller,
} from "./unsignedMacUpdateInstaller.ts";

describe("parseMacCodeSignatureKind", () => {
  it("detects Developer ID signatures", () => {
    expect(
      parseMacCodeSignatureKind({
        exitCode: 0,
        output:
          "Executable=/Applications/Ryco.app/Contents/MacOS/Ryco\nAuthority=Developer ID Application: Example\n",
      }),
    ).toBe("developer-id");
  });

  it("detects ad-hoc signatures", () => {
    expect(
      parseMacCodeSignatureKind({
        exitCode: 0,
        output: "Executable=/Applications/Ryco.app/Contents/MacOS/Ryco\nSignature=adhoc\n",
      }),
    ).toBe("ad-hoc");
  });

  it("detects unsigned bundles from codesign failures", () => {
    expect(
      parseMacCodeSignatureKind({
        exitCode: 1,
        output: "/Applications/Ryco.app: code object is not signed at all\n",
      }),
    ).toBe("unsigned");
  });
});

describe("shouldUseUnsignedMacUpdateInstaller", () => {
  it("uses the fallback for packaged unsigned macOS builds", () => {
    expect(
      shouldUseUnsignedMacUpdateInstaller({
        platform: "darwin",
        isPackaged: true,
        signatureKind: "unsigned",
        disabledByEnv: false,
        forcedByEnv: false,
      }),
    ).toBe(true);
  });

  it("keeps Developer ID builds on the native updater path", () => {
    expect(
      shouldUseUnsignedMacUpdateInstaller({
        platform: "darwin",
        isPackaged: true,
        signatureKind: "developer-id",
        disabledByEnv: false,
        forcedByEnv: false,
      }),
    ).toBe(false);
  });

  it("does not use the fallback outside packaged macOS builds", () => {
    expect(
      shouldUseUnsignedMacUpdateInstaller({
        platform: "linux",
        isPackaged: true,
        signatureKind: "unsigned",
        disabledByEnv: false,
        forcedByEnv: true,
      }),
    ).toBe(false);
  });
});

describe("macOS app path helpers", () => {
  it("resolves the current app bundle path from the executable path", () => {
    expect(resolveMacAppBundlePath("/Applications/Ryco.app/Contents/MacOS/Ryco")).toBe(
      "/Applications/Ryco.app",
    );
  });

  it("resolves the /Applications install target from the current bundle name", () => {
    expect(resolveMacUpdateTargetAppPath("/Volumes/Ryco/Ryco (Nightly).app")).toBe(
      "/Applications/Ryco (Nightly).app",
    );
  });
});

describe("createUnsignedMacUpdateInstallScript", () => {
  it("creates a quoted installer script that extracts, copies, unquarantines, and opens the app", () => {
    const script = createUnsignedMacUpdateInstallScript({
      appLabel: "Laurin's Ryco",
      expectedBundleId: "com.laurinfrank.ryco",
      updateZipPath: "/tmp/Ryco update.zip",
      targetAppPath: "/Applications/Ryco.app",
      waitPid: 123,
      logPath: "/tmp/ryco update.log",
    });

    expect(script).toContain("APP_LABEL='Laurin'\\''s Ryco'");
    expect(script).toContain("UPDATE_ZIP='/tmp/Ryco update.zip'");
    expect(script).toContain("WAIT_PID=123");
    expect(script).toContain('/usr/bin/ditto -x -k "$UPDATE_ZIP" "$STAGING_DIR"');
    expect(script).toContain("/usr/bin/xattr -dr com.apple.quarantine");
    expect(script).toContain('/usr/bin/open "$TARGET_APP"');
    // The bundle id check runs before anything is copied over the app.
    expect(script).toContain("EXPECTED_BUNDLE_ID='com.laurinfrank.ryco'");
    expect(script.indexOf('"$SOURCE_BUNDLE_ID" != "$EXPECTED_BUNDLE_ID"')).toBeGreaterThan(-1);
    expect(script.indexOf('"$SOURCE_BUNDLE_ID" != "$EXPECTED_BUNDLE_ID"')).toBeLessThan(
      script.indexOf('/usr/bin/ditto "$SOURCE_APP" "$TEMP_TARGET"'),
    );
  });
});

describe.runIf(process.platform === "darwin")("the unsigned macOS installer script", () => {
  const installWith = (bundleId: string) => {
    const root = mkdtempSync(join(tmpdir(), "ryco-unsigned-installer-"));
    const app = join(root, "src", "Ryco Nightly.app", "Contents");
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>\n`,
    );
    const zip = join(root, "update.zip");
    execFileSync("/usr/bin/ditto", [
      "-c",
      "-k",
      "--keepParent",
      join(root, "src", "Ryco Nightly.app"),
      zip,
    ]);
    const target = join(root, "Applications", "Ryco.app");
    mkdirSync(join(target, "Contents"), { recursive: true });
    writeFileSync(join(target, "Contents", "marker"), "stable");
    const scriptPath = join(root, "install.zsh");
    writeFileSync(
      scriptPath,
      createUnsignedMacUpdateInstallScript({
        appLabel: "Ryco",
        expectedBundleId: "com.laurinfrank.ryco",
        updateZipPath: zip,
        targetAppPath: target,
        // A pid that is not running, so the script does not wait.
        waitPid: 999_999,
        logPath: join(root, "install.log"),
      }),
    );
    const result = spawnSync("/bin/zsh", [scriptPath], { encoding: "utf8" });
    return { result, target, log: () => readFileSync(join(root, "install.log"), "utf8") };
  };

  it("refuses a downloaded bundle of another app and leaves this one in place", () => {
    const { result, target, log } = installWith("com.laurinfrank.ryco.nightly");
    expect(result.status).toBe(1);
    expect(readFileSync(join(target, "Contents", "marker"), "utf8")).toBe("stable");
    expect(log()).toContain("refusing to replace this app with another one");
  });
});
