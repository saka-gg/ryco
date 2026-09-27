import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import release from "../../../packages/shared/src/cuaDriverRelease.json" with { type: "json" };

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
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  run("./build-appsnap-helper.mjs", ["--arch", arch]);
  // Reuse only checksum/provenance-verified artifacts. A stale artifact is an
  // explicit build failure; remove it to rebuild the pinned source.
  const artifact =
    process.env.RYCO_CUA_ARTIFACT_DIR ??
    (existsSync(`${resources}/provenance.json`) ? resources : undefined);
  run("./provision-cua-driver.mjs", [
    "--arch",
    arch,
    ...(artifact ? ["--artifact-dir", artifact] : []),
  ]);
}
