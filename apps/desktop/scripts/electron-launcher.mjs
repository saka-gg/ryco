import { findLocalMacSigningIdentity } from "../../../packages/shared/src/macLocalSigning.ts";
// This file mostly exists because we want dev mode to say "Ryco (Dev)" instead of "electron"

import { writeMacAppBootstrap, writeMacLaunchConfiguration } from "./mac-launcher-bootstrap.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const APP_DISPLAY_NAME = isDevelopment ? "Ryco (Dev)" : "Ryco";
const APP_BUNDLE_ID = isDevelopment ? "com.sak0a.ryco.dev" : "com.sak0a.ryco";
const APP_PROTOCOL = isDevelopment ? "ryco-dev" : "ryco";
const LAUNCHER_VERSION = 5;
const MAC_LAUNCH_SERVICES_REGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(__dirname, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const defaultIconPath = join(desktopDir, "resources", "icon.icns");
const developmentMacIconPngPath = join(repoRoot, "assets", "dev", "ryco-macos-1024.png");
const developmentMacIconsetPath = join(repoRoot, "assets", "dev", "ryco-macos.iconset");

function setPlistString(plistPath, key, value) {
  const replaceResult = spawnSync("plutil", ["-replace", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = spawnSync("plutil", ["-insert", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function setPlistJson(plistPath, key, value) {
  const serialized = JSON.stringify(value);
  const replaceResult = spawnSync("plutil", ["-replace", key, "-json", serialized, plistPath], {
    encoding: "utf8",
  });
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = spawnSync("plutil", ["-insert", key, "-json", serialized, plistPath], {
    encoding: "utf8",
  });
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) {
    return;
  }

  const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to run ${command} ${args.join(" ")}: ${details}`.trim());
}

function latestMtimeMs(filePath) {
  if (!existsSync(filePath)) return 0;
  const stat = statSync(filePath);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let latest = stat.mtimeMs;
  for (const entry of readdirSync(filePath)) {
    const child = latestMtimeMs(join(filePath, entry));
    if (child > latest) latest = child;
  }
  return latest;
}

function ensureDevelopmentIconIcns(runtimeDir) {
  const generatedIconPath = join(runtimeDir, "icon-dev.icns");
  mkdirSync(runtimeDir, { recursive: true });

  const hasIconset = existsSync(developmentMacIconsetPath);
  const hasSourcePng = existsSync(developmentMacIconPngPath);
  if (!hasIconset && !hasSourcePng) {
    return defaultIconPath;
  }

  const sourceMtimeMs = hasIconset
    ? latestMtimeMs(developmentMacIconsetPath)
    : statSync(developmentMacIconPngPath).mtimeMs;
  if (existsSync(generatedIconPath) && statSync(generatedIconPath).mtimeMs >= sourceMtimeMs) {
    return generatedIconPath;
  }

  if (hasIconset) {
    try {
      runChecked("iconutil", ["-c", "icns", developmentMacIconsetPath, "-o", generatedIconPath]);
      return generatedIconPath;
    } catch (error) {
      console.warn(
        "[desktop-launcher] Failed to build dev .icns from iconset, falling back to sips resize.",
        error,
      );
    }
  }

  const iconsetRoot = mkdtempSync(join(runtimeDir, "dev-iconset-"));
  const iconsetDir = join(iconsetRoot, "icon.iconset");
  mkdirSync(iconsetDir, { recursive: true });

  try {
    for (const size of [16, 32, 128, 256, 512]) {
      runChecked("sips", [
        "-z",
        String(size),
        String(size),
        developmentMacIconPngPath,
        "--out",
        join(iconsetDir, `icon_${size}x${size}.png`),
      ]);

      const retinaSize = size * 2;
      runChecked("sips", [
        "-z",
        String(retinaSize),
        String(retinaSize),
        developmentMacIconPngPath,
        "--out",
        join(iconsetDir, `icon_${size}x${size}@2x.png`),
      ]);
    }

    runChecked("iconutil", ["-c", "icns", iconsetDir, "-o", generatedIconPath]);
    return generatedIconPath;
  } catch (error) {
    console.warn(
      "[desktop-launcher] Failed to generate dev macOS icon, falling back to default icon.",
      error,
    );
    return defaultIconPath;
  } finally {
    rmSync(iconsetRoot, { recursive: true, force: true });
  }
}

function patchMainBundleInfoPlist(appBundlePath, iconPath) {
  const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleDisplayName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleIdentifier", APP_BUNDLE_ID);
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns");
  setPlistJson(infoPlistPath, "CFBundleURLTypes", [
    {
      CFBundleTypeRole: "Viewer",
      CFBundleURLName: APP_BUNDLE_ID,
      CFBundleURLSchemes: [APP_PROTOCOL],
    },
  ]);

  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  copyFileSync(iconPath, join(resourcesDir, "icon.icns"));
  copyFileSync(iconPath, join(resourcesDir, "electron.icns"));
}

function macBootstrapEnvironment() {
  const allowedKeys = [
    "RYCO_DEV_INSTANCE",
    "RYCO_HOME",
    "RYCO_PORT",
    "VITE_DEV_SERVER_URL",
    "VITE_HOSTED_APP_URL",
  ];
  return Object.fromEntries(
    allowedKeys.flatMap((key) => {
      const value = process.env[key];
      return typeof value === "string" && value.length > 0 ? [[key, value]] : [];
    }),
  );
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function buildMacLauncher(electronBinaryPath) {
  const sourceAppBundlePath = resolve(electronBinaryPath, "../../..");
  // Launch Services does not resolve protocol handlers from temporary
  // worktrees reliably. Keep one stable, user-scoped wrapper per bundle id so
  // the active dev checkout can own ryco-dev:// without touching Ryco.app.
  const runtimeDir = join(
    homedir(),
    "Library",
    "Application Support",
    "Ryco Desktop Launchers",
    APP_BUNDLE_ID,
  );
  const targetAppBundlePath = join(runtimeDir, `${APP_DISPLAY_NAME}.app`);
  const targetBinaryPath = join(targetAppBundlePath, "Contents", "MacOS", "Electron");
  const iconPath = isDevelopment ? ensureDevelopmentIconIcns(runtimeDir) : defaultIconPath;
  const metadataPath = join(runtimeDir, "metadata.json");
  const bootstrapEnvironment = macBootstrapEnvironment();
  const desktopMainPath = join(desktopDir, "dist-electron", "main.cjs");
  const signingIdentity = findLocalMacSigningIdentity() ?? "-";

  mkdirSync(runtimeDir, { recursive: true });

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    electronVersion: createRequire(import.meta.url)("electron/package.json").version,
    arch: process.arch,
    signingIdentity,
    iconDigest: createHash("sha256").update(readFileSync(iconPath)).digest("hex"),
  };

  writeMacLaunchConfiguration(runtimeDir, bootstrapEnvironment, desktopMainPath);
  const currentMetadata = readJson(metadataPath);
  if (
    existsSync(targetBinaryPath) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata)
  ) {
    return targetBinaryPath;
  }

  rmSync(targetAppBundlePath, { recursive: true, force: true });
  // Framework bundles depend on relative symlinks such as Versions/Current.
  // Node otherwise rewrites them to absolute paths into node_modules, which
  // makes Chromium fail to resolve ICU and helper resources from the wrapper.
  cpSync(sourceAppBundlePath, targetAppBundlePath, {
    recursive: true,
    verbatimSymlinks: true,
  });
  patchMainBundleInfoPlist(targetAppBundlePath, iconPath);
  writeMacAppBootstrap(targetAppBundlePath, isDevelopment);
  // Editing Info.plist invalidates Electron's upstream signature. Launch
  // Services refuses a protocol claim from that modified bundle until the
  // complete local wrapper is signed again.
  runChecked("codesign", [
    "--force",
    "--deep",
    "--timestamp=none",
    "--sign",
    signingIdentity,
    targetAppBundlePath,
  ]);
  runChecked(MAC_LAUNCH_SERVICES_REGISTER, ["-f", targetAppBundlePath]);
  writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);

  return targetBinaryPath;
}

export function resolveElectronPath() {
  const require = createRequire(import.meta.url);
  const electronBinaryPath = require("electron");

  if (process.platform !== "darwin") {
    return electronBinaryPath;
  }

  // Development must launch from its uniquely identified wrapper bundle too.
  // Otherwise Launch Services records ryco-dev:// against the shared
  // com.github.Electron bundle and may deliver the callback to an unrelated
  // Electron checkout instead of the running Ryco (Dev) authorization broker.
  return buildMacLauncher(electronBinaryPath);
}
