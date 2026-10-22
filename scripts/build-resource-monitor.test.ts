import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { buildResourceMonitor } from "./build-resource-monitor.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));

let root: string;
// The checkout whose sources the mocked Cargo build compiles.
let checkout: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ryco-resource-monitor-test-"));
  vi.stubEnv("RYCO_NATIVE_BUILD_CACHE_DIR", join(root, "cache"));
  // Only macOS hosts ask xcrun for the SDK identity that keys the cache.
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "toolchain" } as never);
  vi.mocked(execFileSync).mockImplementation(((command: string, args: readonly string[]) => {
    if (command === "rustup") {
      const target = args[args.indexOf("--target") + 1]!;
      const source = readFileSync(join(checkout, "native/resource-monitor/src/main.rs"), "utf8");
      const binary = join(
        checkout,
        "native/resource-monitor/target",
        target,
        "release/ryco-resource-monitor",
      );
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, `${target}:${source}`);
    }
    return "";
  }) as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function useCheckout(name: string, source = "fn main() {}") {
  checkout = join(root, name);
  const monitor = join(checkout, "native/resource-monitor");
  mkdirSync(join(monitor, "src"), { recursive: true });
  writeFileSync(join(monitor, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.95.0"\n');
  writeFileSync(join(monitor, "src/main.rs"), source);
  writeFileSync(join(monitor, "LICENSE"), "license");
  return checkout;
}

function cargoTargets() {
  return vi
    .mocked(execFileSync)
    .mock.calls.filter(([command]) => command === "rustup")
    .map(([, args]) => args![args!.indexOf("--target") + 1]);
}

describe("resource monitor build", () => {
  it("reuses cached binaries across checkouts and rebuilds changed sources", () => {
    buildResourceMonitor({ root: useCheckout("first"), architecture: "x64", platform: "linux" });
    buildResourceMonitor({ root: useCheckout("second"), architecture: "x64", platform: "linux" });
    expect(cargoTargets()).toEqual(["x86_64-unknown-linux-gnu"]);
    const staged = join(
      checkout,
      "apps/server/dist/resource-monitor/linux-x64/ryco-resource-monitor",
    );
    expect(readFileSync(staged, "utf8")).toBe("x86_64-unknown-linux-gnu:fn main() {}");
    expect(readFileSync(join(checkout, "apps/server/dist/resource-monitor/LICENSE"), "utf8")).toBe(
      "license",
    );

    buildResourceMonitor({
      root: useCheckout("third", "fn main() { changed() }"),
      architecture: "x64",
      platform: "linux",
    });
    expect(cargoTargets()).toHaveLength(2);
  });

  it("caches each macOS architecture under its own key", () => {
    const first = useCheckout("first");
    // The desktop app's Apple Silicon monitor, then the npm CLI's Intel Mac monitor.
    buildResourceMonitor({ root: first, architecture: "arm64", platform: "darwin" });
    buildResourceMonitor({ root: first, architecture: "x64", platform: "darwin" });
    buildResourceMonitor({ root: first, architecture: "arm64", platform: "darwin" });
    expect(cargoTargets()).toEqual(["aarch64-apple-darwin", "x86_64-apple-darwin"]);
    const distribution = join(first, "apps/server/dist/resource-monitor");
    expect(readFileSync(join(distribution, "darwin-arm64/ryco-resource-monitor"), "utf8")).toBe(
      "aarch64-apple-darwin:fn main() {}",
    );
    expect(readFileSync(join(distribution, "darwin-x64/ryco-resource-monitor"), "utf8")).toBe(
      "x86_64-apple-darwin:fn main() {}",
    );
  });
});
