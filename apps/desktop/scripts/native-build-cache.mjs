import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Outside worktrees and cloud-managed source directories. Deleting this directory
// only costs a rebuild; never use a cached executable without checking its hash.
export function nativeBuildCacheDirectory() {
  return resolve(
    process.env.RYCO_NATIVE_BUILD_CACHE_DIR ?? join(homedir(), ".ryco", "cache", "native-builds"),
  );
}

export function fingerprint(...inputs) {
  const hash = createHash("sha256");
  hash.update("ryco-native-build-cache-v1\0");
  for (const input of inputs) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

// Relative names and contents allow identical checkouts to share artifacts.
export function sourceTreeFingerprint(directory, excludedDirectories = []) {
  const inputs = [];
  function visit(path, relative) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (
        ["target", ".git"].includes(entry.name) ||
        excludedDirectories.includes(resolve(path, entry.name))
      )
        continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(path, entry.name), name);
      else if (entry.isFile()) inputs.push(name, readFileSync(join(path, entry.name)));
      else throw new Error(`Native build inputs must be regular files: ${join(path, entry.name)}`);
    }
  }
  visit(directory, "");
  return fingerprint(...inputs);
}

export function nativeBuildEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) =>
        /^(CARGO_PROFILE_|CARGO_TARGET_|CARGO_BUILD_|CARGO_HOME$|RUSTC$|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|RUSTC_WRAPPER$|RUSTC_WORKSPACE_WRAPPER$|CC($|_)|CXX($|_)|CFLAGS($|_)|CXXFLAGS($|_)|CPPFLAGS$|LDFLAGS$|SDKROOT$|MACOSX_DEPLOYMENT_TARGET$|DEVELOPER_DIR$)/.test(
          key,
        ),
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function swiftToolchainIdentity() {
  return [
    ["swiftc", "--version"],
    ["--sdk", "macosx", "--show-sdk-path"],
    ["--sdk", "macosx", "--show-sdk-version"],
  ].map((args) => {
    const result = spawnSync("xcrun", args, { encoding: "utf8" });
    if (result.error || result.status !== 0)
      throw new Error(
        `Cannot identify the Swift toolchain: ${result.error?.message ?? result.stderr}`,
      );
    return result.stdout.trim();
  });
}

export function swiftModuleCacheDirectory(identity) {
  const directory = join(nativeBuildCacheDirectory(), "swift-modules", fingerprint(identity));
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function stageNativeBinary(source, output) {
  mkdirSync(dirname(output), { recursive: true });
  const temporary = mkdtempSync(join(dirname(output), ".native-stage-"));
  try {
    const pending = join(temporary, "binary");
    copyFileSync(source, pending);
    chmodSync(pending, 0o755);
    renameSync(pending, output);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

// Callers finish verification before publication; another builder may have
// already published this immutable key while our compiler was running.
export function publishNativeCacheDirectory(temporary, cache, usable) {
  if (!usable(cache)) rmSync(cache, { recursive: true, force: true });
  try {
    renameSync(temporary, cache);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !usable(cache)) throw error;
  }
}

export function buildCachedNativeBinary({ name, key, output, validate, build }) {
  const parent = join(nativeBuildCacheDirectory(), "artifacts", name);
  const cache = join(parent, key);
  function usable(directory) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, "build.json"), "utf8"));
      const binary = join(directory, "binary");
      return (
        metadata.key === key &&
        metadata.sha256 === fingerprint(readFileSync(binary)) &&
        validate(binary)
      );
    } catch {
      return false;
    }
  }
  if (usable(cache)) {
    stageNativeBinary(join(cache, "binary"), output);
    console.error(`[native] Reusing ${name} (${key.slice(0, 12)})`);
    return output;
  }
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, ".build-"));
  try {
    const binary = join(temporary, "binary");
    build(binary, temporary);
    chmodSync(binary, 0o755);
    if (!validate(binary)) throw new Error(`Native ${name} artifact verification failed.`);
    writeFileSync(
      join(temporary, "build.json"),
      JSON.stringify({ key, sha256: fingerprint(readFileSync(binary)) }),
    );
    // Stage our verified result before publishing. Concurrent builders may finish
    // the same key; an atomic directory rename keeps partial results invisible.
    stageNativeBinary(binary, output);
    publishNativeCacheDirectory(temporary, cache, usable);
    console.error(`[native] Built ${name} (${key.slice(0, 12)})`);
    return output;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function desktopBuildArch({ development = false, defaultArch = "universal" } = {}) {
  const arch = process.env.RYCO_DESKTOP_ARCH ?? (development ? process.arch : defaultArch);
  if (!["arm64", "x64", "universal"].includes(arch))
    throw new Error(`Unsupported native build architecture: ${arch}`);
  return arch;
}
