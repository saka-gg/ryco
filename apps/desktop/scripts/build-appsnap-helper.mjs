#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import {
  assertDesktopBuildArch,
  buildCachedNativeBinary,
  fingerprint,
  nativeBuildEnvironment,
  swiftModuleCacheDirectory,
  swiftToolchainIdentity,
} from "./native-build-cache.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptsDirectory = dirname(scriptPath);
const desktopDirectory = resolve(scriptsDirectory, "..");
const sourceDirectory = join(desktopDirectory, "native", "appsnap");

export const defaultAppSnapHelperPath = join(
  desktopDirectory,
  "resources",
  "ryco-computer-ui-helper",
);

const frameworkArguments = [
  "-framework",
  "AVFoundation",
  "-framework",
  "AppKit",
  "-framework",
  "CoreServices",
  "-framework",
  "CoreGraphics",
  "-framework",
  "CoreImage",
  "-framework",
  "CoreMedia",
  "-framework",
  "CoreVideo",
  "-framework",
  "ScreenCaptureKit",
];

/** The Mac app is Apple Silicon only; Intel (x64) and universal requests are refused. */
export function swiftTargetForArch(arch) {
  return `${assertDesktopBuildArch(arch, "darwin")}-apple-macos12.3`;
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: desktopDirectory,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  if (result.status === 0) {
    return;
  }

  const details = [result.stdout, result.stderr]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  const suffix = details ? `\n${details}` : "";
  throw new Error(
    `AppSnap helper command failed (${command} ${arguments_.join(" ")}): ${result.status ?? "unknown"}${suffix}`,
  );
}

export function buildAppSnapHelper({
  arch = process.arch,
  outputPath = defaultAppSnapHelperPath,
  release = false,
  quiet = false,
} = {}) {
  if (process.platform !== "darwin") {
    throw new Error("The AppSnap helper can only be built on macOS.");
  }

  const target = swiftTargetForArch(arch);
  const sources = readdirSync(sourceDirectory)
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => join(sourceDirectory, name));
  if (sources.length === 0) {
    throw new Error(`No Swift sources found in ${sourceDirectory}.`);
  }

  const resolvedOutputPath = resolve(outputPath);
  const toolchain = swiftToolchainIdentity();
  const key = fingerprint(
    "appsnap-v2",
    arch,
    release,
    target,
    frameworkArguments,
    toolchain,
    nativeBuildEnvironment(),
    readFileSync(scriptPath),
    ...sources.flatMap((source) => [source.slice(sourceDirectory.length), readFileSync(source)]),
  );
  const moduleCacheDirectory = swiftModuleCacheDirectory(toolchain);
  const buildEnvironment = {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: moduleCacheDirectory,
    SWIFT_MODULECACHE_PATH: moduleCacheDirectory,
  };
  return buildCachedNativeBinary({
    name: "appsnap",
    key,
    output: resolvedOutputPath,
    validate: (binary) =>
      spawnSync("codesign", ["--verify", "--strict", binary], { encoding: "utf8" }).status === 0,
    build(unsignedBinary) {
      const optimizationArguments = release
        ? ["-O", "-whole-module-optimization"]
        : ["-Onone", "-g"];
      run(
        "xcrun",
        [
          "swiftc",
          ...optimizationArguments,
          "-module-name",
          "SynaraAppSnapHelper",
          "-target",
          target,
          ...frameworkArguments,
          ...sources,
          "-o",
          unsignedBinary,
        ],
        { env: buildEnvironment },
      );

      // Dev helpers are ad-hoc signed. electron-builder replaces this signature
      // with the release identity because the packaged path is listed in mac.binaries.
      run("codesign", ["--force", "--sign", "-", "--timestamp=none", unsignedBinary]);

      if (!quiet) console.error(`[appsnap] Built ${arch} Swift helper for macOS 12.3+`);
    },
  });
}

function parseCommandLine(arguments_) {
  let arch = process.arch;
  let outputPath = defaultAppSnapHelperPath;
  let release = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    switch (argument) {
      case "--arch":
        index += 1;
        if (index >= arguments_.length) {
          throw new Error(
            "--arch requires arm64 (the Mac app is Apple Silicon only; x64 and universal are not supported).",
          );
        }
        arch = arguments_[index];
        break;
      case "--output":
        index += 1;
        if (index >= arguments_.length) {
          throw new Error("--output requires a path.");
        }
        outputPath = arguments_[index];
        break;
      case "--release":
        release = true;
        break;
      default:
        throw new Error(`Unknown AppSnap helper build argument: ${argument}`);
    }
  }

  return { arch, outputPath, release };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    buildAppSnapHelper(parseCommandLine(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
