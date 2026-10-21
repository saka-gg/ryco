import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildNativeSecurityHelper } from "./build-native-security-helper.mjs";
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
let root;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = mkdtempSync(join(tmpdir(), "ryco-security-build-test-"));
  const desktop = join(root, "desktop");
  mkdirSync(join(desktop, "native/macos"), { recursive: true });
  writeFileSync(join(desktop, "native/macos/RycoDesktopSecurityHelper.swift"), "source");
  vi.stubGlobal("process", {
    ...process,
    platform: "darwin",
    arch: "arm64",
    env: { RYCO_NATIVE_BUILD_CACHE_DIR: join(root, "cache") },
  });
  spawnSync.mockImplementation((command, args) => {
    const index = args.indexOf("-o") >= 0 ? args.indexOf("-o") : args.indexOf("-output");
    if (index >= 0) writeFileSync(args[index + 1], "binary");
    return { status: 0, stdout: "toolchain" };
  });
  return desktop;
}
function compilerCalls() {
  return spawnSync.mock.calls.filter(([, args]) => args.includes("-target"));
}

describe("native security helper", () => {
  it("builds one slice for development and caches it", () => {
    const desktop = fixture();
    buildNativeSecurityHelper(desktop, { development: true });
    buildNativeSecurityHelper(desktop, { development: true });
    expect(compilerCalls()).toHaveLength(1);
    expect(compilerCalls()[0][1]).toContain("arm64-apple-macosx11.0");
    expect(compilerCalls()[0][2].env.SWIFT_MODULECACHE_PATH).toContain(
      join(root, "cache/swift-modules"),
    );
  });
  it("shares one arm64 build between development and normal builds", () => {
    const desktop = fixture();
    buildNativeSecurityHelper(desktop, { development: true });
    buildNativeSecurityHelper(desktop);
    expect(compilerCalls()).toHaveLength(1);
    expect(compilerCalls()[0][1]).toContain("arm64-apple-macosx11.0");
    expect(spawnSync.mock.calls.some(([, args]) => args.includes("lipo"))).toBe(false);
  });
  it.each(["x64", "universal"])("refuses a %s macOS build", (arch) => {
    const desktop = fixture();
    process.env.RYCO_DESKTOP_ARCH = arch;
    expect(() => buildNativeSecurityHelper(desktop)).toThrow(/Apple Silicon \(arm64\) only/);
    expect(compilerCalls()).toHaveLength(0);
  });
  it("invalidates the cache after a compiler change", () => {
    const desktop = fixture();
    buildNativeSecurityHelper(desktop);
    const original = spawnSync.getMockImplementation();
    spawnSync.mockImplementation((command, args) => ({
      ...original(command, args),
      stdout: "new toolchain",
    }));
    buildNativeSecurityHelper(desktop);
    expect(compilerCalls()).toHaveLength(2);
  });
});
