/**
 * Where the Android SDK is and what of it is missing.
 *
 * Resolution: `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then the locations
 * Android Studio installs to (`~/Library/Android/sdk` on macOS,
 * `~/Android/Sdk` on Linux, `%LOCALAPPDATA%\Android\Sdk` on Windows). Without
 * any, the tools are looked up on PATH.
 *
 * Setup steps name the exact package to install and, when no AVD exists, the
 * `avdmanager` command for a system image that is already installed.
 *
 * @module device/android/androidSdk
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import type { DeviceSetupStep } from "@ryco/contracts";

export type AndroidTool = "adb" | "emulator" | "avdmanager";

export interface AndroidSdk {
  /** The SDK root, or undefined when none was found (tools then come from PATH). */
  readonly root: string | undefined;
  /** How it was found, for messages. */
  readonly source: "ANDROID_HOME" | "ANDROID_SDK_ROOT" | "default" | "none";
  readonly tool: (name: AndroidTool) => string;
}

export function androidSdkCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  return [
    path.join(home, "Library", "Android", "sdk"),
    path.join(home, "Android", "Sdk"),
    path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Android", "Sdk"),
  ];
}

export function resolveAndroidSdk(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly home?: string;
    readonly platform?: NodeJS.Platform;
    readonly exists?: (candidate: string) => boolean;
  } = {},
): AndroidSdk {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  let root: string | undefined;
  let source: AndroidSdk["source"] = "none";
  if (env.ANDROID_HOME?.trim()) {
    root = env.ANDROID_HOME.trim();
    source = "ANDROID_HOME";
  } else if (env.ANDROID_SDK_ROOT?.trim()) {
    root = env.ANDROID_SDK_ROOT.trim();
    source = "ANDROID_SDK_ROOT";
  } else {
    root = androidSdkCandidates(env, home).find(exists);
    if (root) source = "default";
  }
  const exe = (name: string) => name + (platform === "win32" ? ".exe" : "");
  const tool = (name: AndroidTool): string => {
    if (!root) return name === "avdmanager" && platform === "win32" ? "avdmanager.bat" : exe(name);
    if (name === "adb") return path.join(root, "platform-tools", exe("adb"));
    if (name === "emulator") return path.join(root, "emulator", exe("emulator"));
    return path.join(
      root,
      "cmdline-tools",
      "latest",
      "bin",
      platform === "win32" ? "avdmanager.bat" : "avdmanager",
    );
  };
  return { root, source, tool };
}

/** Installed `system-images;android-N;tag;abi` packages, newest API first. */
export function installedSystemImages(
  root: string | undefined,
  read: (directory: string) => string[] = (directory) => {
    try {
      return readdirSync(directory);
    } catch {
      return [];
    }
  },
  exists: (file: string) => boolean = existsSync,
): string[] {
  if (!root) return [];
  const images: Array<{ readonly api: number; readonly id: string }> = [];
  const base = path.join(root, "system-images");
  for (const platform of read(base)) {
    const api = Number(/^android-(\d+)/u.exec(platform)?.[1] ?? "0");
    for (const tag of read(path.join(base, platform))) {
      for (const abi of read(path.join(base, platform, tag))) {
        // A package directory without its system image is a stub.
        if (!exists(path.join(base, platform, tag, abi, "system.img"))) continue;
        images.push({ api, id: `system-images;${platform};${tag};${abi}` });
      }
    }
  }
  return images.toSorted((a, b) => b.api - a.api).map((image) => image.id);
}

const SDK_MANAGER_HINT =
  "Android Studio → Settings → Languages & Frameworks → Android SDK → SDK Tools";

export function androidSetupSteps(input: {
  readonly sdk: AndroidSdk;
  readonly adb: boolean;
  readonly emulator: boolean;
  /** Null when the AVD list could not be read (no emulator). */
  readonly avdCount: number | null;
  readonly avdmanager: boolean;
  readonly systemImages: readonly string[];
}): DeviceSetupStep[] {
  const found =
    input.sdk.root === undefined
      ? "Found on PATH."
      : `SDK at ${input.sdk.root} (${input.sdk.source}).`;
  const where =
    input.sdk.root === undefined
      ? "No Android SDK found: set ANDROID_HOME, or install Android Studio (it puts the SDK in ~/Library/Android/sdk on macOS)."
      : `SDK at ${input.sdk.root} (${input.sdk.source}).`;
  const steps: DeviceSetupStep[] = [
    {
      id: "install-android-platform-tools",
      label: "Install Android SDK Platform-Tools",
      done: input.adb,
      detail: input.adb
        ? found
        : `${where} Install "Android SDK Platform-Tools" in ${SDK_MANAGER_HINT}, or run: sdkmanager "platform-tools".`,
    },
    {
      id: "install-android-emulator",
      label: "Install the Android Emulator",
      done: input.emulator,
      detail: input.emulator
        ? found
        : `${where} Install "Android Emulator" in ${SDK_MANAGER_HINT}, or run: sdkmanager "emulator".`,
    },
  ];
  if (input.avdCount === null || input.avdCount > 0) {
    if (input.avdCount !== null)
      steps.push({
        id: "create-android-avd",
        label: "Create an Android virtual device",
        done: true,
      });
    return steps;
  }
  const image = input.systemImages[0];
  const create = image
    ? `avdmanager create avd -n Ryco_Pixel -k "${image}" -d pixel_6`
    : 'sdkmanager "system-images;android-35;google_apis;arm64-v8a" (x86_64 on Intel), then avdmanager create avd';
  if (!input.avdmanager)
    steps.push({
      id: "install-android-cmdline-tools",
      label: "Install Android SDK Command-line Tools",
      done: false,
      detail: `Needed to create an AVD without Android Studio. Install "Android SDK Command-line Tools (latest)" in ${SDK_MANAGER_HINT}.`,
    });
  steps.push({
    id: "create-android-avd",
    label: "Create an Android virtual device",
    done: false,
    detail: `Use Android Studio's Device Manager, or run: ${create}`,
  });
  return steps;
}
