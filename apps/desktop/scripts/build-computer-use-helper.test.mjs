import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildComputerUseHelper } from "./build-computer-use-helper.mjs";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const roots = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture(platform, environment = {}) {
  const root = mkdtempSync(join(tmpdir(), "ryco-helper-build-test-"));
  roots.push(root);
  const desktop = join(root, "CloudStorage", "Dropbox", "checkout", "apps", "desktop");
  const source = join(desktop, "native", "computer-use-helper");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(desktop, "browser-extension"), { recursive: true });
  writeFileSync(join(desktop, "browser-extension", "manifest.json"), "{}");
  for (const file of ["LICENSE", "UPSTREAM.md"]) writeFileSync(join(source, file), file);
  vi.stubGlobal("process", {
    ...process,
    platform,
    arch: "arm64",
    env: environment,
  });
  spawnSync.mockImplementation((command, args) => {
    if (args[0] === "+1.98.1") {
      const targetDirectory = args[args.indexOf("--target-dir") + 1];
      const target = args.includes("--target") ? args[args.indexOf("--target") + 1] : "";
      const binary = join(
        targetDirectory,
        target,
        "release",
        `ryco-computer-use${platform === "win32" ? ".exe" : ""}`,
      );
      if (!targetDirectory.startsWith(root)) roots.push(targetDirectory);
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, "helper");
    } else if (command === "xcrun") {
      const outputIndex = args.indexOf("-output");
      for (const binary of args.slice(2, outputIndex))
        expect(readFileSync(binary, "utf8")).toBe("helper");
      writeFileSync(args[outputIndex + 1], "universal helper");
    } else if (args[0] === "--hello") {
      return { status: 0, stdout: JSON.stringify({ protocolVersion: 3 }) };
    }
    return { status: 0 };
  });
  return { desktop, source };
}

function cargoCalls() {
  return spawnSync.mock.calls.filter(([, args]) => args[0] === "+1.98.1");
}

describe("computer-use helper build", () => {
  it("builds both macOS slices outside a cloud checkout and stages the universal helper", () => {
    const f = fixture("darwin");
    buildComputerUseHelper(f.desktop);
    const calls = cargoCalls();
    expect(calls).toHaveLength(2);
    const targetDirectory = calls[0][1][calls[0][1].indexOf("--target-dir") + 1];
    expect(isAbsolute(targetDirectory)).toBe(true);
    expect(targetDirectory.startsWith(f.desktop)).toBe(false);
    expect(calls.map(([, args]) => args[args.indexOf("--target") + 1])).toEqual([
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
    ]);
    for (const [, args, options] of calls) {
      expect(args).toContain("--locked");
      expect(args[args.indexOf("--target-dir") + 1]).toBe(targetDirectory);
      expect(options.cwd).toBe(f.source);
    }
    expect(readFileSync(join(f.desktop, "resources", "ryco-computer-use-helper"), "utf8")).toBe(
      "universal helper",
    );
    expect(
      readFileSync(join(f.desktop, "resources", "computer-use-licenses", "LICENSE"), "utf8"),
    ).toBe("LICENSE");
    expect(
      readFileSync(join(f.desktop, "resources", "browser-extension", "manifest.json"), "utf8"),
    ).toBe("{}");
  });

  it.each(["darwin", "linux", "win32"])(
    "stages from a relative CARGO_TARGET_DIR on %s",
    (platform) => {
      const f = fixture(platform, { CARGO_TARGET_DIR: "custom-target" });
      buildComputerUseHelper(f.desktop);
      for (const [, args] of cargoCalls()) {
        expect(args[args.indexOf("--target-dir") + 1]).toBe(join(f.source, "custom-target"));
      }
      const suffix = platform === "win32" ? ".exe" : "";
      expect(
        readFileSync(join(f.desktop, "resources", `ryco-computer-use-helper${suffix}`), "utf8"),
      ).toContain("helper");
    },
  );

  it("reuses a checkout's cache while separating different checkouts", () => {
    const first = fixture("darwin");
    buildComputerUseHelper(first.desktop);
    buildComputerUseHelper(first.desktop);
    const second = fixture("darwin");
    buildComputerUseHelper(second.desktop);
    const directories = cargoCalls().map(([, args]) => args[args.indexOf("--target-dir") + 1]);
    expect(directories[0]).toBe(directories[2]);
    expect(directories[0]).not.toBe(directories[4]);
  });

  it("reports a failed Cargo command without diagnosing a missing toolchain", () => {
    const f = fixture("darwin");
    spawnSync.mockReturnValue({ status: 1 });
    spawnSync.mockReturnValueOnce({ status: 0 });
    expect(() => buildComputerUseHelper(f.desktop)).toThrow(/cargo \+1\.98\.1 build .*exit 1/);
    expect(spawnSync.mock.calls.some(([command]) => command === "xcrun")).toBe(false);
  });
});
