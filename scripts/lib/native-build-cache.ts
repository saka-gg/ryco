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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Content-addressed cache for native executables shared by the desktop helpers
// and the CLI's resource monitor. Release CI persists it between runs and keeps
// only the entries a build touched (scripts/ci/native-cache.ts prune).

// Outside worktrees and cloud-managed source directories. Deleting this directory
// only costs a rebuild; never use a cached executable without checking its hash.
export function nativeBuildCacheDirectory(): string {
  return resolve(
    process.env.RYCO_NATIVE_BUILD_CACHE_DIR ?? join(homedir(), ".ryco", "cache", "native-builds"),
  );
}

export function fingerprint(...inputs: readonly unknown[]): string {
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
export function sourceTreeFingerprint(
  directory: string,
  excludedDirectories: readonly string[] = [],
): string {
  const inputs: Array<string | Buffer> = [];
  function visit(path: string, relative: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true }).toSorted((a, b) =>
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

export function nativeBuildEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) =>
        /^(CARGO_PROFILE_|CARGO_TARGET_|CARGO_BUILD_|CARGO_HOME$|RUSTC$|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|RUSTC_WRAPPER$|RUSTC_WORKSPACE_WRAPPER$|CC($|_)|CXX($|_)|CFLAGS($|_)|CXXFLAGS($|_)|CPPFLAGS$|LDFLAGS$|SDKROOT$|MACOSX_DEPLOYMENT_TARGET$|DEVELOPER_DIR$)/.test(
          key,
        ),
      )
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
}

export function swiftToolchainIdentity(): string[] {
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

export function swiftModuleCacheDirectory(identity: readonly string[]): string {
  const directory = join(nativeBuildCacheDirectory(), "swift-modules", fingerprint(identity));
  mkdirSync(directory, { recursive: true });
  return directory;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function withWindowsFileRetries<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EACCES", "EBUSY", "EPERM"].includes(String(errorCode(error))) ||
        attempt === 10
      ) {
        throw error;
      }
      // Windows can briefly retain executable handles after validation exits.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
    }
  }
}

function removeNativeDirectory(directory: string): void {
  withWindowsFileRetries(() => rmSync(directory, { recursive: true, force: true }));
}

// CI prunes entries whose mtime predates its restore marker, so every entry a
// build reuses must look fresh. Best effort: a miss only costs a later rebuild.
export function markNativeCacheEntryUsed(directory: string): void {
  const now = new Date();
  try {
    utimesSync(directory, now, now);
  } catch (error) {
    console.error(`[native] Could not mark ${directory} as used: ${String(error)}`);
  }
}

export function stageNativeBinary(source: string, output: string): void {
  mkdirSync(dirname(output), { recursive: true });
  const temporary = mkdtempSync(join(dirname(output), ".native-stage-"));
  try {
    const pending = join(temporary, "binary");
    copyFileSync(source, pending);
    chmodSync(pending, 0o755);
    withWindowsFileRetries(() => renameSync(pending, output));
  } finally {
    removeNativeDirectory(temporary);
  }
}

// Callers finish verification before publication; another builder may have
// already published this immutable key while our compiler was running.
export function publishNativeCacheDirectory(
  temporary: string,
  cache: string,
  usable: (directory: string) => boolean,
): void {
  if (!usable(cache)) removeNativeDirectory(cache);
  withWindowsFileRetries(() => {
    try {
      renameSync(temporary, cache);
    } catch (error) {
      // Windows reports EPERM when the destination directory already exists.
      // Accept a competing publication only after revalidating its contents.
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(errorCode(error))) || !usable(cache))
        throw error;
    }
  });
  // A competing publication accepted above may be older than this build.
  markNativeCacheEntryUsed(cache);
}

export interface CachedNativeBinaryOptions {
  readonly name: string;
  readonly key: string;
  readonly output: string;
  readonly validate: (binary: string) => boolean;
  readonly build: (binary: string, temporary: string) => void;
}

export function buildCachedNativeBinary({
  name,
  key,
  output,
  validate,
  build,
}: CachedNativeBinaryOptions): string {
  const parent = join(nativeBuildCacheDirectory(), "artifacts", name);
  const cache = join(parent, key);
  // CreateProcess requires the executable extension even for temporary and
  // cached helpers. Validate exactly the executable we will later restore.
  const binaryName = process.platform === "win32" ? "binary.exe" : "binary";
  function usable(directory: string): boolean {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, "build.json"), "utf8"));
      const binary = join(directory, binaryName);
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
    stageNativeBinary(join(cache, binaryName), output);
    markNativeCacheEntryUsed(cache);
    console.error(`[native] Reusing ${name} (${key.slice(0, 12)})`);
    return output;
  }
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, ".build-"));
  try {
    const binary = join(temporary, binaryName);
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
    removeNativeDirectory(temporary);
  }
}
