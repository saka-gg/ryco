#!/usr/bin/env node
// Builds Ryco Computer Use, the LSUIElement helper app macOS gives Computer Use's grants to
// (docs/superpowers/specs/2026-11-07-computer-use-helper-app.md). `build` compiles the Swift
// executable into resources; `assemble` wraps it in a named, flavor-specific bundle. The dev
// launcher and the release packager assemble; electron-builder signs packaged copies.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPUTER_USE_HELPER_EXECUTABLE,
  computerUseHelperInfoPlist,
} from "../../../packages/shared/src/computerUseHelperApp.ts";
import {
  assertDesktopBuildArch,
  buildCachedNativeBinary,
  fingerprint,
  nativeBuildEnvironment,
  swiftModuleCacheDirectory,
  swiftToolchainIdentity,
} from "./native-build-cache.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const desktopDirectory = resolve(dirname(scriptPath), "..");
const sourceDirectory = join(desktopDirectory, "native", "computer-use-app");

/** The bare executable `build` produces; `assemble` copies it into a bundle. */
export const defaultComputerUseAppExecutablePath = join(
  desktopDirectory,
  "resources",
  "ryco-computer-use-app",
);

const ICON_NAME = "AppIcon";

function run(command, args, runner = spawnSync) {
  const result = runner(command, args, { encoding: "utf8" });
  if (result.status === 0) return;
  const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  throw new Error(
    `Ryco Computer Use build failed (${command} ${args.join(" ")}): ${result.status ?? "unknown"}${details ? `\n${details}` : ""}`,
  );
}

export function buildComputerUseAppExecutable({
  arch = process.arch,
  outputPath = defaultComputerUseAppExecutablePath,
  release = false,
  quiet = false,
} = {}) {
  if (process.platform !== "darwin") return undefined;
  const target = `${assertDesktopBuildArch(arch, "darwin")}-apple-macos13.0`;
  const sources = readdirSync(sourceDirectory)
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => join(sourceDirectory, name));
  const toolchain = swiftToolchainIdentity();
  const key = fingerprint(
    "computer-use-app-v2",
    arch,
    release,
    target,
    toolchain,
    nativeBuildEnvironment(),
    readFileSync(scriptPath),
    ...sources.flatMap((source) => [source.slice(sourceDirectory.length), readFileSync(source)]),
  );
  const moduleCache = swiftModuleCacheDirectory(toolchain);
  return buildCachedNativeBinary({
    name: "computer-use-app",
    key,
    output: resolve(outputPath),
    validate: (binary) =>
      spawnSync("codesign", ["--verify", "--strict", binary], { encoding: "utf8" }).status === 0,
    build(unsignedBinary) {
      const environment = {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: moduleCache,
        SWIFT_MODULECACHE_PATH: moduleCache,
      };
      const result = spawnSync(
        "xcrun",
        [
          "swiftc",
          ...(release ? ["-O", "-whole-module-optimization"] : ["-Onone", "-g"]),
          "-module-name",
          "RycoComputerUse",
          "-target",
          target,
          "-framework",
          "AppKit",
          "-framework",
          "Security",
          ...sources,
          "-o",
          unsignedBinary,
        ],
        { cwd: desktopDirectory, encoding: "utf8", env: environment },
      );
      if (result.status !== 0)
        throw new Error(`Ryco Computer Use compile failed:\n${result.stderr ?? ""}`.trim());
      // The bundle gets its real signature when it is assembled or packaged.
      run("codesign", ["--force", "--sign", "-", "--timestamp=none", unsignedBinary]);
      if (!quiet) console.error(`[computer-use-app] Built ${arch} helper app executable`);
    },
  });
}

/** What makes an assembled bundle current: rebuild when any of it changes. */
export function computerUseAppDigest({
  executable,
  identity,
  version,
  iconPath,
  resourcesDirectory,
  hostPath,
  signingIdentity,
}) {
  return createHash("sha256")
    .update(readFileSync(executable))
    .update(readFileSync(iconPath))
    .update(
      JSON.stringify([
        identity.name,
        identity.bundleId,
        version,
        resourcesDirectory ?? null,
        hostPath ?? null,
        signingIdentity ?? null,
      ]),
    )
    .digest("hex");
}

/**
 * Writes `<outputDirectory>/<identity.name>.app` and replaces any previous copy only once the new
 * one is complete. `signingIdentity` null leaves signing to electron-builder (packaged builds).
 */
export function assembleComputerUseApp({
  executable,
  outputDirectory,
  identity,
  version,
  iconPath,
  resourcesDirectory,
  hostPath,
  signingIdentity = "-",
  runner = spawnSync,
}) {
  if (!existsSync(executable))
    throw new Error(`Missing Ryco Computer Use executable: ${executable}`);
  if (!existsSync(iconPath)) throw new Error(`Missing Ryco Computer Use icon: ${iconPath}`);
  mkdirSync(outputDirectory, { recursive: true });
  const bundle = join(outputDirectory, `${identity.name}.app`);
  const staging = join(outputDirectory, `.${identity.bundleId}.${randomUUID()}.app`);
  try {
    const contents = join(staging, "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"), { recursive: true });
    writeFileSync(
      join(contents, "Info.plist"),
      computerUseHelperInfoPlist({
        identity,
        version,
        iconName: ICON_NAME,
        ...(resourcesDirectory ? { resourcesDirectory } : {}),
        ...(hostPath ? { hostPath } : {}),
      }),
    );
    writeFileSync(join(contents, "PkgInfo"), "APPL????");
    const binary = join(contents, "MacOS", COMPUTER_USE_HELPER_EXECUTABLE);
    copyFileSync(executable, binary);
    chmodSync(binary, 0o755);
    copyFileSync(iconPath, join(contents, "Resources", `${ICON_NAME}.icns`));
    if (signingIdentity)
      run("codesign", ["--force", "--timestamp=none", "--sign", signingIdentity, staging], runner);
    rmSync(bundle, { recursive: true, force: true });
    renameSync(staging, bundle);
    return bundle;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const [command = "build", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--release" || flag === "--dev") {
      options[flag.slice(2)] = true;
      continue;
    }
    if (flag === "--no-sign") {
      options.signingIdentity = null;
      continue;
    }
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error(`Invalid Ryco Computer Use build argument: ${flag}`);
    index += 1;
    options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return { command, options };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const { command, options } = parseArguments(process.argv.slice(2));
    if (command === "build") {
      buildComputerUseAppExecutable({
        ...(options.arch ? { arch: options.arch } : {}),
        release: options.release === true,
      });
    } else if (command === "assemble") {
      const bundle = assembleComputerUseApp({
        executable: options.executable ?? defaultComputerUseAppExecutablePath,
        outputDirectory: options.outputDirectory,
        identity: { name: options.name, bundleId: options.bundleId },
        version: options.version,
        iconPath: options.icon,
        ...(options.resourcesDirectory ? { resourcesDirectory: options.resourcesDirectory } : {}),
        ...(options.hostPath ? { hostPath: options.hostPath } : {}),
        signingIdentity: options.signingIdentity === undefined ? "-" : options.signingIdentity,
      });
      console.log(bundle);
    } else {
      throw new Error(`Unknown Ryco Computer Use build command: ${command}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
