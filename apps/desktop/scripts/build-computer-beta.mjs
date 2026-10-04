import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import release from "../../../packages/shared/src/cuaDriverRelease.json" with { type: "json" };
import {
  cuaArtifactCacheDirectory,
  cuaBuildCacheKey,
  usableCuaArtifact,
} from "./cua-build-cache.mjs";

import { publishNativeCacheDirectory } from "./native-build-cache.mjs";

// Native beta is macOS-only. Other platforms keep the existing controller.
if (process.platform === "darwin") {
  const resources = fileURLToPath(new URL("../resources/cua-driver", import.meta.url));
  const arch = process.env.RYCO_DESKTOP_ARCH ?? process.arch;
  const run = (script, args = []) => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(script, import.meta.url)), ...args],
      {
        stdio: "inherit",
        env: { ...process.env, RUSTUP_TOOLCHAIN: release.rustVersion },
      },
    );
    if (result.error || result.status !== 0)
      throw new Error(
        `Native beta build failed: ${script} (${result.error?.message ?? result.status})`,
      );
  };
  run("./build-appsnap-helper.mjs", ["--arch", arch]);
  // Explicit external artifacts still fail closed in the provisioner. Only the
  // managed cache is allowed to turn a stale/corrupt entry into a source rebuild.
  const explicitArtifact = process.env.RYCO_CUA_ARTIFACT_DIR;
  const key = cuaBuildCacheKey(release, process.platform, arch);
  const cache = cuaArtifactCacheDirectory(key);
  const cached = !explicitArtifact && usableCuaArtifact(cache, release, process.platform, arch);
  if (cached) console.error(`[native] Reusing cua (${key.slice(0, 12)})`);
  run("./provision-cua-driver.mjs", [
    "--arch",
    arch,
    ...(explicitArtifact
      ? ["--artifact-dir", explicitArtifact]
      : cached
        ? ["--artifact-dir", cache]
        : []),
  ]);
  // Cache the fully staged, checksum-verified result. Publication is atomic and
  // never exposes an incomplete artifact to another worktree.
  if (!explicitArtifact && !cached) {
    if (!usableCuaArtifact(resources, release, process.platform, arch))
      throw new Error("Built Cua artifact failed cache verification.");
    const parent = dirname(cache);
    mkdirSync(parent, { recursive: true });
    const temporary = mkdtempSync(join(parent, ".build-"));
    try {
      cpSync(resources, temporary, { recursive: true });
      publishNativeCacheDirectory(temporary, cache, (directory) =>
        usableCuaArtifact(directory, release, process.platform, arch),
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
