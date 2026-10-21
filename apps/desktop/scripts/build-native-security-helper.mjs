import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildCachedNativeBinary,
  desktopBuildArch,
  fingerprint,
  nativeBuildEnvironment,
  swiftModuleCacheDirectory,
  swiftToolchainIdentity,
} from "./native-build-cache.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const desktop = resolve(dirname(scriptPath), "..");

export function buildNativeSecurityHelper(
  desktopDirectory = desktop,
  { development = false } = {},
) {
  if (process.platform !== "darwin") return;
  const arch = desktopBuildArch({ development });
  const source = join(desktopDirectory, "native/macos/RycoDesktopSecurityHelper.swift");
  const output = join(desktopDirectory, "resources/ryco-desktop-security-helper");
  const toolchain = swiftToolchainIdentity();
  const key = fingerprint(
    "security-v2",
    arch,
    toolchain,
    nativeBuildEnvironment(),
    readFileSync(source),
    readFileSync(scriptPath),
  );
  const moduleCache = swiftModuleCacheDirectory(toolchain);
  function run(command, args) {
    const result = spawnSync(command, args, {
      cwd: desktopDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: moduleCache,
        SWIFT_MODULECACHE_PATH: moduleCache,
      },
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `Desktop native security helper build failed.\n${result.error?.message ?? `${result.stdout ?? ""}${result.stderr ?? ""}`}`,
      );
  }
  return buildCachedNativeBinary({
    name: "security",
    key,
    output,
    validate: (binary) =>
      spawnSync("codesign", ["--verify", "--strict", binary], { encoding: "utf8" }).status === 0,
    build(binary) {
      // desktopBuildArch only yields arm64 on macOS: the Mac app is Apple Silicon only.
      run("xcrun", [
        "--sdk",
        "macosx",
        "swiftc",
        "-O",
        "-target",
        `${arch}-apple-macosx11.0`,
        "-framework",
        "Security",
        "-framework",
        "CryptoKit",
        source,
        "-o",
        binary,
      ]);
      run("codesign", ["--force", "--sign", "-", "--timestamp=none", binary]);
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  buildNativeSecurityHelper(desktop, { development: process.argv.includes("--dev") });
}
