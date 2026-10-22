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

function fixture(platform, environment = {}, cacheRoot) {
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
    env: { RYCO_NATIVE_BUILD_CACHE_DIR: cacheRoot ?? join(root, "cache"), ...environment },
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
    } else if (args[0] === "--hello") {
      return { status: 0, stdout: JSON.stringify({ protocolVersion: 3 }) };
    }
    return { status: 0, stdout: "toolchain" };
  });
  return { desktop, source };
}

function cargoCalls() {
  return spawnSync.mock.calls.filter(([, args]) => args[0] === "+1.98.1");
}

function lipoCalls() {
  return spawnSync.mock.calls.filter(
    ([command, args]) => command === "xcrun" && args[0] === "lipo",
  );
}

describe("computer-use helper build", () => {
  it("builds the Apple Silicon macOS helper outside a cloud checkout and stages it", () => {
    const f = fixture("darwin");
    buildComputerUseHelper(f.desktop);
    const calls = cargoCalls();
    expect(calls).toHaveLength(1);
    const [, args, options] = calls[0];
    const targetDirectory = args[args.indexOf("--target-dir") + 1];
    expect(isAbsolute(targetDirectory)).toBe(true);
    expect(targetDirectory.startsWith(f.desktop)).toBe(false);
    expect(args[args.indexOf("--target") + 1]).toBe("aarch64-apple-darwin");
    expect(args).toContain("--locked");
    expect(options.cwd).toBe(f.source);
    expect(lipoCalls()).toHaveLength(0);
    expect(readFileSync(join(f.desktop, "resources", "ryco-computer-use-helper"), "utf8")).toBe(
      "helper",
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

  it("reuses verified binaries across worktrees and rebuilds changed sources", () => {
    const first = fixture("darwin");
    const cache = process.env.RYCO_NATIVE_BUILD_CACHE_DIR;
    buildComputerUseHelper(first.desktop);
    buildComputerUseHelper(first.desktop);
    const second = fixture("darwin", {}, cache);
    buildComputerUseHelper(second.desktop);
    expect(cargoCalls()).toHaveLength(1);
    writeFileSync(join(second.source, "new.rs"), "changed source");
    buildComputerUseHelper(second.desktop);
    expect(cargoCalls()).toHaveLength(2);
  });

  it("shares one arm64 macOS build between development and normal builds", () => {
    const f = fixture("darwin");
    buildComputerUseHelper(f.desktop, { development: true });
    buildComputerUseHelper(f.desktop);
    expect(cargoCalls()).toHaveLength(1);
    expect(cargoCalls()[0][1]).toContain("aarch64-apple-darwin");
    expect(lipoCalls()).toHaveLength(0);
  });

  it.each(["x64", "universal"])("refuses a %s macOS helper build", (arch) => {
    const f = fixture("darwin", { RYCO_DESKTOP_ARCH: arch });
    expect(() => buildComputerUseHelper(f.desktop, { development: true })).toThrow(
      /Apple Silicon \(arm64\) only/,
    );
    expect(() => buildComputerUseHelper(f.desktop)).toThrow(/Apple Silicon \(arm64\) only/);
    expect(cargoCalls()).toHaveLength(0);
  });

  it("refuses a development build from an Intel or Rosetta host Node on macOS", () => {
    const f = fixture("darwin");
    vi.stubGlobal("process", { ...process, arch: "x64" });
    expect(() => buildComputerUseHelper(f.desktop, { development: true })).toThrow(
      /Apple Silicon \(arm64\) only/,
    );
    expect(cargoCalls()).toHaveLength(0);
  });

  it.each(["linux", "win32"])("keeps building the host x64 or arm64 helper on %s", (platform) => {
    const f = fixture(platform);
    vi.stubGlobal("process", { ...process, arch: "x64" });
    buildComputerUseHelper(f.desktop);
    expect(cargoCalls()).toHaveLength(1);
    expect(cargoCalls()[0][1]).not.toContain("--target");
    const other = fixture(platform, { RYCO_DESKTOP_ARCH: "arm64" });
    vi.stubGlobal("process", { ...process, arch: "x64" });
    expect(() => buildComputerUseHelper(other.desktop)).toThrow(
      "Build the native helper on a arm64 runner",
    );
    expect(() =>
      buildComputerUseHelper(fixture(platform, { RYCO_DESKTOP_ARCH: "universal" }).desktop),
    ).toThrow("expected arm64 or x64");
  });

  it("reports a failed Cargo command without diagnosing a missing toolchain", () => {
    const f = fixture("darwin");
    spawnSync.mockImplementation((command, args) => ({
      status: args[0] === "+1.98.1" ? 1 : 0,
      stdout: "toolchain",
    }));
    expect(() => buildComputerUseHelper(f.desktop)).toThrow(/cargo \+1\.98\.1 build .*exit 1/);
    expect(lipoCalls()).toHaveLength(0);
  });
});
