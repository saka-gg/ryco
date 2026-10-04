import { copyFileSync, readFileSync } from "node:fs";
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
    build(binary, temporary) {
      const architectures =
        arch === "universal" ? ["x86_64", "arm64"] : [arch === "x64" ? "x86_64" : "arm64"];
      const binaries = architectures.map((architecture) => {
        const thin = join(temporary, architecture);
        run("xcrun", [
          "--sdk",
          "macosx",
          "swiftc",
          "-O",
          "-target",
          `${architecture}-apple-macosx11.0`,
          "-framework",
          "Security",
          "-framework",
          "CryptoKit",
          source,
          "-o",
          thin,
        ]);
        return thin;
      });
      if (binaries.length === 1) copyFileSync(binaries[0], binary);
      else run("xcrun", ["lipo", "-create", ...binaries, "-output", binary]);
      run("codesign", ["--force", "--sign", "-", "--timestamp=none", binary]);
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  buildNativeSecurityHelper(desktop, { development: process.argv.includes("--dev") });
}
