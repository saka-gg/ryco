import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import release from "../../../packages/shared/src/cuaDriverRelease.json" with { type: "json" };
import { cuaBuildCacheKey, usableCuaArtifact } from "./cua-build-cache.mjs";
let root;
afterEach(() => {
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture(overrides = {}) {
  root = mkdtempSync(join(tmpdir(), "ryco-cua-cache-test-"));
  const bytes = Buffer.from("fixture binary");
  writeFileSync(join(root, "cua-driver"), bytes);
  writeFileSync(
    join(root, "provenance.json"),
    JSON.stringify({
      ...release,
      platform: "darwin",
      architectures: ["arm64"],
      patched: true,
      linuxBrowserPatchSha256: undefined,
      binarySha256: createHash("sha256").update(bytes).digest("hex"),
      ...overrides,
    }),
  );
}
describe("Cua artifact cache", () => {
  it("accepts only matching provenance, architecture, and checksum", () => {
    fixture();
    expect(usableCuaArtifact(root, release, "darwin", "arm64")).toBe(true);
    expect(usableCuaArtifact(root, release, "darwin", "universal")).toBe(false);
    expect(usableCuaArtifact(root, release, "linux", "arm64")).toBe(false);
    writeFileSync(join(root, "cua-driver"), "tampered");
    expect(usableCuaArtifact(root, release, "darwin", "arm64")).toBe(false);
  });
  it.each([
    { source: "different commit" },
    { nativeRevision: 0 },
    { patchSha256: "wrong patch" },
    { rustVersion: "wrong compiler" },
    { patched: false },
  ])("rejects stale or unpatched provenance: %j", (override) => {
    fixture(override);
    expect(usableCuaArtifact(root, release, "darwin", "arm64")).toBe(false);
  });
  it("keys compiler intermediates by pinned release, architecture, and build settings", () => {
    const key = cuaBuildCacheKey(release, "linux", "arm64");
    expect(cuaBuildCacheKey(release, "linux", "x64")).not.toBe(key);
    expect(cuaBuildCacheKey({ ...release, nativeRevision: 40 }, "linux", "arm64")).not.toBe(key);
    vi.stubEnv("CARGO_PROFILE_RELEASE_STRIP", "symbols");
    expect(cuaBuildCacheKey(release, "linux", "arm64")).not.toBe(key);
  });
});
