import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import release from "../../../packages/shared/src/cuaDriverRelease.json" with { type: "json" };
import { buildComputerBeta } from "./build-computer-beta.mjs";
import { cuaArtifactCacheDirectory, cuaBuildCacheKey } from "./cua-build-cache.mjs";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

let root;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("native computer beta build", () => {
  it("provisions from a verified Cua cache entry and marks it used", () => {
    root = mkdtempSync(join(tmpdir(), "ryco-computer-beta-test-"));
    vi.stubGlobal("process", {
      ...process,
      platform: "darwin",
      arch: "arm64",
      env: { RYCO_NATIVE_BUILD_CACHE_DIR: join(root, "cache") },
    });
    spawnSync.mockReturnValue({ status: 0, stdout: "toolchain" });
    const cache = cuaArtifactCacheDirectory(cuaBuildCacheKey(release, "darwin", "arm64"));
    const bytes = Buffer.from("cua binary");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "cua-driver"), bytes);
    writeFileSync(
      join(cache, "provenance.json"),
      JSON.stringify({
        ...release,
        platform: "darwin",
        architectures: ["arm64"],
        patched: true,
        linuxBrowserPatchSha256: undefined,
        binarySha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    const longAgo = new Date("2020-01-01T00:00:00Z");
    utimesSync(cache, longAgo, longAgo);

    buildComputerBeta();

    const provision = spawnSync.mock.calls.find(([, args]) =>
      args[0].endsWith("provision-cua-driver.mjs"),
    );
    expect(provision[1].slice(1)).toEqual(["--arch", "arm64", "--artifact-dir", cache]);
    expect(statSync(cache).mtimeMs).toBeGreaterThan(longAgo.getTime());
  });
});
