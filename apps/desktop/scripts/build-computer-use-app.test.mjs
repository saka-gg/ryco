import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { assembleComputerUseApp, computerUseAppDigest } from "./build-computer-use-app.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ryco-cu-assemble-"));
  roots.push(root);
  writeFileSync(join(root, "exe"), "binary");
  writeFileSync(join(root, "icon.icns"), "icon");
  return {
    root,
    options: {
      executable: join(root, "exe"),
      outputDirectory: join(root, "out"),
      identity: { name: "Ryco Computer Use (Dev)", bundleId: "com.sak0a.ryco.dev.computer-use" },
      version: "0.1.39",
      iconPath: join(root, "icon.icns"),
      resourcesDirectory: "/checkout/apps/desktop/resources",
    },
  };
}

describe("assembleComputerUseApp", () => {
  it("writes a complete bundle and signs it as one", () => {
    const { root, options } = fixture();
    const runner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const bundle = assembleComputerUseApp({ ...options, signingIdentity: "ABC", runner });
    expect(bundle).toBe(join(root, "out", "Ryco Computer Use (Dev).app"));
    const plist = readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");
    expect(plist).toContain("<string>com.sak0a.ryco.dev.computer-use</string>");
    expect(plist).toContain("<string>/checkout/apps/desktop/resources</string>");
    expect(readFileSync(join(bundle, "Contents", "MacOS", "RycoComputerUse"), "utf8")).toBe(
      "binary",
    );
    expect(statSync(join(bundle, "Contents", "MacOS", "RycoComputerUse")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(bundle, "Contents", "Resources", "AppIcon.icns"), "utf8")).toBe(
      "icon",
    );
    expect(runner).toHaveBeenCalledWith(
      "codesign",
      ["--force", "--timestamp=none", "--sign", "ABC", expect.stringContaining(".app")],
      expect.anything(),
    );
  });

  it("leaves signing to the packager and keeps the old copy when a build fails", () => {
    const { options } = fixture();
    const runner = vi.fn(() => ({ status: 0 }));
    const bundle = assembleComputerUseApp({ ...options, signingIdentity: null, runner });
    expect(runner).not.toHaveBeenCalled();
    const failing = vi.fn(() => ({ status: 1, stderr: "no identity" }));
    expect(() =>
      assembleComputerUseApp({
        ...options,
        version: "0.2.0",
        signingIdentity: "-",
        runner: failing,
      }),
    ).toThrow("no identity");
    expect(readFileSync(join(bundle, "Contents", "Info.plist"), "utf8")).toContain("0.1.39");
    expect(existsSync(join(options.outputDirectory, ".com.sak0a.ryco.dev.computer-use"))).toBe(
      false,
    );
  });

  it("changes its digest with anything that changes the bundle", () => {
    const { options } = fixture();
    const base = computerUseAppDigest(options);
    expect(computerUseAppDigest({ ...options })).toBe(base);
    expect(computerUseAppDigest({ ...options, version: "0.2.0" })).not.toBe(base);
    expect(computerUseAppDigest({ ...options, resourcesDirectory: "/other" })).not.toBe(base);
    expect(computerUseAppDigest({ ...options, signingIdentity: "ABC" })).not.toBe(base);
  });
});
