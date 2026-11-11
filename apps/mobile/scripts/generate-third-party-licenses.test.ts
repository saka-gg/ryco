/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ThirdPartyLicenseManifest } from "@ryco/shared/thirdPartyLicenses";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { licensePolicyViolation } from "../../../scripts/lib/third-party-license-policy.ts";
import {
  readThirdPartyLicensesConfig,
  type ThirdPartyLicensesConfig,
} from "../../../scripts/lib/third-party-licenses.ts";
import {
  generateMobileThirdPartyLicenseManifest,
  MOBILE_APP_DIR,
  THIRD_PARTY_LICENSES_CONFIG,
} from "./generate-third-party-licenses.mts";
import {
  nativeIdMatches,
  parseGradleDependencies,
  parsePodspecDependencies,
  parseSpmPackages,
  readNativeInventory,
  type NativeInventory,
} from "./thirdPartyNativeDependencies.mts";

let manifest: ThirdPartyLicenseManifest;
let config: ThirdPartyLicensesConfig;
let native: NativeInventory;

beforeAll(async () => {
  // Generation itself fails on a package without notice text or with a disallowed license.
  manifest = await generateMobileThirdPartyLicenseManifest();
  config = (await readThirdPartyLicensesConfig(THIRD_PARTY_LICENSES_CONFIG)).config;
  native = readNativeInventory(MOBILE_APP_DIR);
}, 120_000);

const listed = (name: string) =>
  manifest.entries.some((entry) => entry.kind === "package" && entry.name === name);

describe("the phone app's open source license manifest", () => {
  it("gives every entry notice text and a license the policy admits", () => {
    expect(manifest.entries.length).toBeGreaterThan(100);
    const problems = manifest.entries.flatMap((entry) => {
      const violation = licensePolicyViolation(entry, config.reviewedLicenses);
      return [
        ...(violation ? [violation] : []),
        ...(entry.noticeText.trim().length === 0 ? [`${entry.name} has no notice text`] : []),
      ];
    });
    expect(problems).toEqual([]);
  });

  it("gives every weak copyleft review a reason", () => {
    for (const reviewed of config.reviewedLicenses) {
      expect(reviewed.reason.length, reviewed.name).toBeGreaterThan(10);
    }
  });

  it("lists every package Expo autolinking links natively", () => {
    const thirdParty = native.packages.filter(
      (pkg) => !pkg.name.startsWith("@ryco/") && pkg.root.includes("/node_modules/"),
    );
    expect(thirdParty.length).toBeGreaterThan(30);
    expect(thirdParty.filter((pkg) => !listed(pkg.name)).map((pkg) => pkg.name)).toEqual([]);
  });

  it("covers every third-party native library with a notice or a reasoned exclusion", () => {
    const patterns = [
      ...config.customNotices.flatMap((notice) => notice.nativeDependencies ?? []),
      ...config.nativeDependencyExclusions.map((exclusion) => exclusion.id),
    ];
    const uncovered = [...native.dependencies]
      .filter(([id]) => !patterns.some((pattern) => nativeIdMatches(pattern, id)))
      .map(([id, owners]) => `${id} (from ${owners.join(", ")})`);
    expect(native.dependencies.size).toBeGreaterThan(20);
    expect(uncovered).toEqual([]);
  });

  it("lists the dev dependencies inlined into shipped renderer documents and assets", () => {
    const packageJson = JSON.parse(readFileSync(join(MOBILE_APP_DIR, "package.json"), "utf8")) as {
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    const sources = [
      "src/features/terminal/renderer",
      "src/features/devices/stream/renderer",
      "modules/ryco-markdown-text/scripts",
    ].flatMap((directory) =>
      readdirSync(join(MOBILE_APP_DIR, directory))
        .filter((name) => /\.(?:[cm]?[jt]s)$/u.test(name))
        .map((name) => readFileSync(join(MOBILE_APP_DIR, directory, name), "utf8")),
    );
    const imported = new Set(
      sources.flatMap((source) =>
        Array.from(
          source.matchAll(/from\s+["']((?:@[^/"']+\/)?[^./"'][^/"']*)/gu),
          (match) => match[1]!,
        ),
      ),
    );
    const inlinedDevDependencies = [...imported].filter(
      (name) => name in packageJson.devDependencies,
    );
    expect(inlinedDevDependencies.length).toBeGreaterThan(0);
    expect(inlinedDevDependencies.filter((name) => !listed(name))).toEqual([]);
  });

  it("credits the code Ryco adapted and the fonts and icons it ships", () => {
    const names = manifest.entries.map((entry) => entry.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "T3 Code",
        "react-native-uitextview",
        "@expo-google-fonts/dm-sans",
        "@tabler/icons-react-native",
        "Hermes",
        "SDWebImage",
      ]),
    );
  });
});

describe("native dependency parsing", () => {
  it("reads podspec dependencies outside test specs, subspecs as their pod", () => {
    const podspec = [
      "Pod::Spec.new do |s|",
      "  s.dependency 'ExpoModulesCore'",
      '  s.dependency "libavif/libdav1d" unless disable',
      "  s.test_spec 'Tests' do |test_spec|",
      "    test_spec.dependency 'ExpoModulesTestCore'",
      "  end",
      "end",
    ].join("\n");
    expect(parsePodspecDependencies(podspec)).toEqual(["ExpoModulesCore", "libavif"]);
  });

  it("reads runtime Maven coordinates, conditional ones included", () => {
    const gradle = [
      "dependencies {",
      "  implementation 'com.facebook.react:react-android'",
      '  api "com.github.bumptech.glide:glide:${GLIDE_VERSION}"',
      '  testImplementation "junit:junit:4.13"',
      '  add(config, "com.google.mlkit:barcode-scanning:17.3.0")',
      "}",
    ].join("\n");
    expect(parseGradleDependencies(gradle)).toEqual([
      "com.facebook.react:react-android",
      "com.github.bumptech.glide:glide",
      "com.google.mlkit:barcode-scanning",
    ]);
  });

  it("reads Swift package URLs and matches wildcard ids", () => {
    const spm = JSON.stringify({
      products: [{ spmPackages: [{ url: "https://github.com/SDWebImage/SDWebImage.git" }] }],
    });
    expect(parseSpmPackages(spm)).toEqual(["https://github.com/SDWebImage/SDWebImage"]);
    expect(nativeIdMatches("maven:androidx.*", "maven:androidx.core:core")).toBe(true);
    expect(nativeIdMatches("pod:SDWebImage", "pod:SDWebImageSVGCoder")).toBe(false);
  });
});
