import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { assertCuaArtifactProvenance } from "./cua-artifact-provenance.mjs";
import {
  fingerprint,
  nativeBuildCacheDirectory,
  nativeBuildEnvironment,
  swiftToolchainIdentity,
} from "./native-build-cache.mjs";

export function cuaBuildCacheKey(release, platform, arch) {
  return fingerprint(
    "cua-v1",
    release,
    platform,
    arch,
    nativeBuildEnvironment(),
    platform === "darwin" ? swiftToolchainIdentity() : [],
    ...[
      "./provision-cua-driver.mjs",
      "./cua-artifact-provenance.mjs",
      "./cua-build-cache.mjs",
      "./native-build-cache.mjs",
    ].map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)))),
  );
}

export function cuaArtifactCacheDirectory(key) {
  return join(nativeBuildCacheDirectory(), "artifacts", "cua", key);
}

export function usableCuaArtifact(directory, release, platform, arch) {
  try {
    const provenance = JSON.parse(readFileSync(join(directory, "provenance.json"), "utf8"));
    const bytes = readFileSync(
      join(directory, platform === "win32" ? "cua-driver.exe" : "cua-driver"),
    );
    assertCuaArtifactProvenance({
      provenance,
      release,
      platform,
      architectures: arch === "universal" ? ["arm64", "x64"] : [arch],
      binarySha256: createHash("sha256").update(bytes).digest("hex"),
    });
    return true;
  } catch {
    return false;
  }
}
