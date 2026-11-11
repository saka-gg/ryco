#!/usr/bin/env node
/// <reference types="node" />
/**
 * Writes the phone app's open source license manifest into the ignored
 * `.generated/third-party-licenses/` package, which Metro resolves as
 * `@ryco/mobile-third-party-licenses` (see `metro.config.js`, which runs this before Metro
 * starts, so dev servers, `bundle:check`, Xcode and EAS bundles all carry a current manifest).
 *
 * The manifest lists the app's production dependency closure, the dev dependencies the config
 * says are inlined into shipped artifacts, and the config's custom notices for the app, iOS and
 * Android (native libraries, adapted code). `src/features/settings/mobileThirdPartyLicenses.ts`
 * loads it on first use only.
 *
 * Runs in about a second and skips the work when its inputs are unchanged. Never touches the
 * network. Run by hand with `node apps/mobile/scripts/generate-third-party-licenses.mts`.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeThirdPartyLicenseManifest,
  type ThirdPartyLicenseManifest,
} from "@ryco/shared/thirdPartyLicenses";

import {
  generateThirdPartyLicenseManifest,
  readThirdPartyLicensesConfig,
} from "../../../scripts/lib/third-party-licenses.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const MOBILE_APP_DIR = resolve(scriptDir, "..");
export const REPOSITORY_ROOT = resolve(MOBILE_APP_DIR, "../..");
export const THIRD_PARTY_LICENSES_CONFIG = join(
  REPOSITORY_ROOT,
  "third-party-licenses.config.json",
);
export const GENERATED_LICENSES_DIR = join(MOBILE_APP_DIR, ".generated", "third-party-licenses");
/** The custom notices the phone app shows: the app as a whole and each native platform. */
export const MOBILE_LICENSE_BUNDLES = ["android", "ios", "mobile"] as const;

export function generateMobileThirdPartyLicenseManifest(): Promise<ThirdPartyLicenseManifest> {
  return generateThirdPartyLicenseManifest({
    configFile: THIRD_PARTY_LICENSES_CONFIG,
    customNoticeBundles: MOBILE_LICENSE_BUNDLES,
    packageManifests: [{ bundle: "mobile", path: join(MOBILE_APP_DIR, "package.json") }],
  });
}

async function filesUnder(directory: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();
}

/**
 * A hash of everything the manifest is made from. bun.lock covers every installed package and
 * workspace manifest; the rest are the config, the files it names, the templates and the code.
 */
async function inputsKey(): Promise<string> {
  const { config, directory } = await readThirdPartyLicensesConfig(THIRD_PARTY_LICENSES_CONFIG);
  const noticeFiles = [
    ...config.customNotices.flatMap((notice) => notice.noticeFiles ?? []),
    ...config.packageOverrides.flatMap((override) =>
      override.noticeFile ? [override.noticeFile] : [],
    ),
  ].map((file) => resolve(directory, file));
  const inputs = [
    join(REPOSITORY_ROOT, "bun.lock"),
    THIRD_PARTY_LICENSES_CONFIG,
    fileURLToPath(import.meta.url),
    join(REPOSITORY_ROOT, "scripts/lib/third-party-licenses.ts"),
    join(REPOSITORY_ROOT, "scripts/lib/third-party-license-policy.ts"),
    join(REPOSITORY_ROOT, "packages/shared/src/thirdPartyLicenses.ts"),
    ...(await filesUnder(join(REPOSITORY_ROOT, "third-party-licenses"))),
    ...noticeFiles,
  ];
  const hash = createHash("sha256");
  for (const input of inputs) {
    hash.update(`\0${input}\0`).update(await readFile(input));
  }
  return hash.digest("hex");
}

async function writeIfChanged(path: string, contents: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === contents) return;
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
  // Written aside and renamed, so a watching Metro never reads half a file.
  await writeFile(`${path}.tmp`, contents, "utf8");
  await rename(`${path}.tmp`, path);
}

/** Regenerates the manifest package when its inputs changed; returns whether it did. */
export async function writeMobileThirdPartyLicenses(): Promise<boolean> {
  const keyPath = join(GENERATED_LICENSES_DIR, "inputs.sha256");
  const key = await inputsKey();
  try {
    const [previousKey] = await Promise.all([
      readFile(keyPath, "utf8"),
      readFile(join(GENERATED_LICENSES_DIR, "index.js"), "utf8"),
      readFile(join(GENERATED_LICENSES_DIR, "manifest.json"), "utf8"),
    ]);
    if (previousKey.trim() === key) return false;
  } catch {
    // Missing output: generate it.
  }
  const manifest = await generateMobileThirdPartyLicenseManifest();
  await mkdir(GENERATED_LICENSES_DIR, { recursive: true });
  await writeIfChanged(
    join(GENERATED_LICENSES_DIR, "package.json"),
    '{"name":"@ryco/mobile-third-party-licenses","private":true,"main":"index.js"}\n',
  );
  const manifestJson = JSON.stringify(encodeThirdPartyLicenseManifest(manifest));
  // The plain manifest is for build-time checks (`metro.config.js`); it is never bundled.
  await writeIfChanged(join(GENERATED_LICENSES_DIR, "manifest.json"), `${manifestJson}\n`);
  // The app gets it deflated: ~480 KB of notice text is ~55 KB as base64, inflated on the
  // license screen with the fflate the app already ships (`mobileThirdPartyLicenses.ts`).
  const deflateRawBase64 = deflateRawSync(Buffer.from(manifestJson, "utf8"), {
    level: 9,
  }).toString("base64");
  await writeIfChanged(
    join(GENERATED_LICENSES_DIR, "index.js"),
    `// Generated by apps/mobile/scripts/generate-third-party-licenses.mts. Do not edit.\nmodule.exports = ${JSON.stringify({ deflateRawBase64 })};\n`,
  );
  await writeIfChanged(keyPath, `${key}\n`);
  return true;
}

if (import.meta.main) {
  await writeMobileThirdPartyLicenses();
}
