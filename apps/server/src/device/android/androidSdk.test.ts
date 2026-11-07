import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { androidSetupSteps, installedSystemImages, resolveAndroidSdk } from "./androidSdk.ts";

describe("Android SDK resolution", () => {
  it("prefers ANDROID_HOME, then ANDROID_SDK_ROOT, then Android Studio's default", () => {
    expect(
      resolveAndroidSdk({ env: { ANDROID_HOME: "/a", ANDROID_SDK_ROOT: "/b" }, home: "/h" }),
    ).toMatchObject({
      root: "/a",
      source: "ANDROID_HOME",
    });
    expect(resolveAndroidSdk({ env: { ANDROID_SDK_ROOT: "/b" }, home: "/h" }).source).toBe(
      "ANDROID_SDK_ROOT",
    );
    const found = resolveAndroidSdk({
      env: {},
      home: "/h",
      platform: "darwin",
      exists: (candidate) => candidate === path.join("/h", "Library", "Android", "sdk"),
    });
    expect(found).toMatchObject({
      root: path.join("/h", "Library", "Android", "sdk"),
      source: "default",
    });
    expect(found.tool("adb")).toBe(
      path.join("/h", "Library", "Android", "sdk", "platform-tools", "adb"),
    );
    expect(found.tool("avdmanager")).toBe(
      path.join("/h", "Library", "Android", "sdk", "cmdline-tools", "latest", "bin", "avdmanager"),
    );
    const none = resolveAndroidSdk({ env: {}, home: "/h", platform: "win32", exists: () => false });
    expect([none.root, none.source, none.tool("adb")]).toEqual([undefined, "none", "adb.exe"]);
  });

  it("lists installed system images, newest API first, skipping stubs", () => {
    const tree: Record<string, string[]> = {
      "/sdk/system-images": ["android-33", "android-35"],
      "/sdk/system-images/android-33": ["google_apis"],
      "/sdk/system-images/android-33/google_apis": ["arm64-v8a"],
      "/sdk/system-images/android-35": ["google_apis", "default"],
      "/sdk/system-images/android-35/google_apis": ["arm64-v8a"],
      "/sdk/system-images/android-35/default": ["arm64-v8a"],
    };
    const images = installedSystemImages(
      "/sdk",
      (directory) => tree[directory.replaceAll("\\", "/")] ?? [],
      (file) => !file.replaceAll("\\", "/").includes("android-35/default"),
    );
    expect(images).toEqual([
      "system-images;android-35;google_apis;arm64-v8a",
      "system-images;android-33;google_apis;arm64-v8a",
    ]);
  });

  it("names the package to install and the exact AVD command", () => {
    const sdk = resolveAndroidSdk({ env: { ANDROID_HOME: "/sdk" } });
    const steps = androidSetupSteps({
      sdk,
      adb: false,
      emulator: true,
      avdCount: 0,
      avdmanager: false,
      systemImages: ["system-images;android-35;google_apis;arm64-v8a"],
    });
    expect(steps.map((step) => [step.id, step.done])).toEqual([
      ["install-android-platform-tools", false],
      ["install-android-emulator", true],
      ["install-android-cmdline-tools", false],
      ["create-android-avd", false],
    ]);
    expect(steps[0]!.detail).toContain('sdkmanager "platform-tools"');
    expect(steps[3]!.detail).toContain('-k "system-images;android-35;google_apis;arm64-v8a"');
    const ready = androidSetupSteps({
      sdk,
      adb: true,
      emulator: true,
      avdCount: 2,
      avdmanager: true,
      systemImages: [],
    });
    expect(ready.every((step) => step.done)).toBe(true);
  });
});
