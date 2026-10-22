import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildCachedNativeBinary,
  desktopBuildArch,
  fingerprint,
  nativeBuildEnvironment,
} from "./native-build-cache.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const desktop = resolve(dirname(scriptPath), "..");

// The Node-API addon behind the translucent window's adjustable desktop blur
// (native/macos/RycoWindowMaterial.m, loaded by src/windowTranslucency.ts).
export function buildWindowMaterialAddon(desktopDirectory = desktop, { development = false } = {}) {
  if (process.platform !== "darwin") return;
  // Always arm64: the Mac app is Apple Silicon only.
  const arch = desktopBuildArch({ development });
  const source = join(desktopDirectory, "native/macos/RycoWindowMaterial.m");
  const output = join(desktopDirectory, "resources/ryco-window-material.node");
  const compileArguments = [
    "--sdk",
    "macosx",
    "clang",
    "-x",
    "objective-c",
    "-fobjc-arc",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-arch",
    arch,
    "-mmacosx-version-min=11.0",
    // Node-API symbols resolve against the host Electron binary at load time.
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-framework",
    "AppKit",
  ];
  const key = fingerprint(
    "window-material-v1",
    arch,
    compileArguments,
    nativeBuildEnvironment(),
    readFileSync(source),
    readFileSync(scriptPath),
  );
  function run(command, args, temporary) {
    const result = spawnSync(command, args, {
      cwd: desktopDirectory,
      encoding: "utf8",
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(temporary, "module-cache") },
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `Desktop window material addon build failed.\n${result.error?.message ?? `${result.stdout ?? ""}${result.stderr ?? ""}`}`,
      );
  }
  return buildCachedNativeBinary({
    name: "window-material",
    key,
    output,
    validate: (binary) =>
      spawnSync("codesign", ["--verify", "--strict", binary], { encoding: "utf8" }).status === 0,
    build(binary, temporary) {
      run("xcrun", [...compileArguments, source, "-o", binary], temporary);
      // Ad-hoc for dev; electron-builder re-signs it because the packaged path is
      // listed in mac.binaries.
      run("codesign", ["--force", "--sign", "-", "--timestamp=none", binary], temporary);
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  buildWindowMaterialAddon(desktop, { development: process.argv.includes("--dev") });
}
