// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Metro's config loads this before an Effect runtime exists.
/**
 * Generates the open source license manifest a Ryco client shows: every third-party package that
 * ships in it, with its license and notice text, plus the hand-maintained notices for what npm does
 * not describe (native libraries, fonts, adapted code). Adapted from pingdotgg/t3code
 * (`scripts/lib/third-party-licenses.ts`, MIT, see THIRD_PARTY_NOTICES.md).
 *
 * `apps/mobile/metro.config.js` imports this file directly (Node strips its types), so it may only
 * use erasable TypeScript and must import with `.ts` extensions. It never touches the network:
 * generated notices come from the SPDX templates committed under `third-party-licenses/spdx/`;
 * `scripts/sync-third-party-license-notices.ts` downloads a missing one.
 */

import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type {
  ThirdPartyLicenseEntry,
  ThirdPartyLicenseManifest,
} from "@ryco/shared/thirdPartyLicenses";

import {
  licensePolicyViolation,
  normalizeLicenseExpression,
  type ReviewedLicense,
} from "./third-party-license-policy.ts";

const SPDX_LICENSE_LIST_VERSION = "v3.28.0";
const SPDX_LICENSE_LIST_REVISION = "c4a7237ec8f4654e867546f9f409749300f1bf4c";
const SPDX_TEMPLATE_DIRECTORY = "third-party-licenses/spdx";

export interface ThirdPartyLicensePackageManifest {
  readonly bundle: string;
  readonly path: string | URL;
}

interface GeneratedNoticeConfigEntry {
  readonly copyrights?: ReadonlyArray<string>;
  readonly licenseId: string;
  readonly preamble?: ReadonlyArray<string>;
}

interface PackageJson {
  readonly bin?: unknown;
  readonly browser?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly exports?: unknown;
  readonly homepage?: unknown;
  readonly license?: unknown;
  readonly licenses?: unknown;
  readonly main?: unknown;
  readonly module?: unknown;
  readonly name?: unknown;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly "react-native"?: unknown;
  readonly repository?: unknown;
  readonly sass?: unknown;
  readonly style?: unknown;
  readonly types?: unknown;
  readonly typings?: unknown;
  readonly version?: unknown;
}

export interface CustomNoticeConfigEntry {
  readonly bundles?: ReadonlyArray<string>;
  readonly license: string;
  readonly name: string;
  readonly generatedNotices?: ReadonlyArray<GeneratedNoticeConfigEntry>;
  /**
   * Native dependencies this notice covers, as `pod:<name>`, `spm:<repository url>` or
   * `maven:<group>:<artifact>` (a trailing `*` matches a prefix). The native coverage test reads
   * them; the manifest does not carry them.
   */
  readonly nativeDependencies?: ReadonlyArray<string>;
  readonly noticeFiles?: ReadonlyArray<string>;
  readonly sourceUrl?: string;
  readonly version?: string;
}

interface PackageNoticeOverrideConfigEntry {
  readonly generatedNotices?: ReadonlyArray<GeneratedNoticeConfigEntry>;
  readonly license?: string;
  readonly name?: string;
  readonly noticeFile?: string;
  readonly repositoryUrl?: string;
  readonly sourceUrl?: string;
  readonly version?: string;
}

/** Development dependencies whose code a build inlines into a shipped artifact. */
export interface BundledDevDependenciesConfigEntry {
  readonly bundle: string;
  readonly names: ReadonlyArray<string>;
  /** The manifest that declares them, relative to the config file. */
  readonly packageManifest: string;
  readonly reason: string;
}

/**
 * Dependencies of `from` (a package name, or `*` for any) that run only while building: bundler,
 * CLI, codegen and config-plugin tooling. The walk neither lists nor follows them. `names` entries
 * match exactly or, ending in `*`, by prefix. The production bundle check
 * (`findUnlistedBundledPackages`) fails if one of them reaches the JavaScript bundle after all.
 */
export interface BuildOnlyDependenciesConfigEntry {
  readonly from: string;
  readonly names: ReadonlyArray<string>;
  readonly reason: string;
}

/** A native dependency that needs no notice of its own, and why. */
export interface NativeDependencyExclusion {
  readonly id: string;
  readonly reason: string;
}

export interface ThirdPartyLicensesConfig {
  readonly buildOnlyDependencies: ReadonlyArray<BuildOnlyDependenciesConfigEntry>;
  readonly bundledDevDependencies: ReadonlyArray<BundledDevDependenciesConfigEntry>;
  readonly customNotices: ReadonlyArray<CustomNoticeConfigEntry>;
  readonly nativeDependencyExclusions: ReadonlyArray<NativeDependencyExclusion>;
  readonly packageOverrides: ReadonlyArray<PackageNoticeOverrideConfigEntry>;
  readonly reviewedLicenses: ReadonlyArray<ReviewedLicense>;
}

interface SpdxLicenseDetails {
  readonly licenseId: string;
  readonly licenseText: string;
}

export interface CollectedPackage {
  readonly bundles: Set<string>;
  readonly packageJson: PackageJson;
  readonly packageRoot: string;
}

interface PackageCollection {
  readonly byIdentity: Map<string, CollectedPackage>;
}

const EMPTY_CONFIG: ThirdPartyLicensesConfig = {
  buildOnlyDependencies: [],
  bundledDevDependencies: [],
  customNotices: [],
  nativeDependencyExclusions: [],
  packageOverrides: [],
  reviewedLicenses: [],
};

const NOTICE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;
const NOTICE_TEXT_EXTENSIONS = new Set([
  "",
  ".0bsd",
  ".agpl",
  ".apache2",
  ".bsd",
  ".gpl",
  ".isc",
  ".lgpl",
  ".markdown",
  ".md",
  ".mit",
  ".mpl",
  ".mpl2",
  ".rst",
  ".txt",
  ".unlicense",
]);
const FIRST_PARTY_PACKAGE_PREFIX = "@ryco/";

function isNoticeTextFile(fileName: string): boolean {
  return (
    NOTICE_FILE_PATTERN.test(fileName) &&
    NOTICE_TEXT_EXTENSIONS.has(NodePath.extname(fileName).toLowerCase())
  );
}

/** Ryco's own packages: `@ryco/*`, or any workspace package (resolved outside node_modules). */
function isFirstPartyPackage(name: string, packageRoot: string): boolean {
  return (
    name.startsWith(FIRST_PARTY_PACKAGE_PREFIX) ||
    !packageRoot.split(NodePath.sep).includes("node_modules")
  );
}

function asPath(value: string | URL): string {
  return value instanceof URL ? NodeURL.fileURLToPath(value) : NodePath.resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function readRequiredString(value: Record<string, unknown>, key: string, context: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`${context} must define a non-empty "${key}" string.`);
  }
  return field.trim();
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`${context} must define "${key}" as a non-empty string when present.`);
  }
  return field.trim();
}

function readOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
  context: string,
): ReadonlyArray<string> | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (
    !Array.isArray(field) ||
    field.length === 0 ||
    field.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw new Error(`${context} must define "${key}" as a non-empty string array.`);
  }
  return field.map((entry) => (entry as string).trim());
}

function readArray(value: unknown, field: string): ReadonlyArray<unknown> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Third-party license config field "${field}" must be an array.`);
  }
  return value;
}

function decodeGeneratedNotice(value: unknown, context: string): GeneratedNoticeConfigEntry {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  const copyrights = readOptionalStringArray(value, "copyrights", context);
  const preamble = readOptionalStringArray(value, "preamble", context);
  return {
    licenseId: readRequiredString(value, "licenseId", context),
    ...(copyrights !== undefined ? { copyrights } : {}),
    ...(preamble !== undefined ? { preamble } : {}),
  };
}

function decodeGeneratedNotices(
  value: unknown,
  context: string,
): ReadonlyArray<GeneratedNoticeConfigEntry> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must define "generatedNotices" as a non-empty array.`);
  }
  return value.map((entry, index) =>
    decodeGeneratedNotice(entry, `${context} generated notice at index ${String(index)}`),
  );
}

function decodeCustomNotices(value: unknown): ReadonlyArray<CustomNoticeConfigEntry> {
  return readArray(value, "customNotices").map((entry, index) => {
    const context = `Third-party custom notice at index ${String(index)}`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
    const version = readOptionalString(entry, "version", context);
    const sourceUrl = readOptionalString(entry, "sourceUrl", context);
    const bundles = readOptionalStringArray(entry, "bundles", context);
    const nativeDependencies = readOptionalStringArray(entry, "nativeDependencies", context);
    const noticeFile = readOptionalString(entry, "noticeFile", context);
    const noticeFiles = readOptionalStringArray(entry, "noticeFiles", context);
    const generatedNotices = decodeGeneratedNotices(entry.generatedNotices, context);
    const noticeSourceCount =
      Number(noticeFile !== undefined) +
      Number(noticeFiles !== undefined) +
      Number(generatedNotices !== undefined);
    if (noticeSourceCount !== 1) {
      throw new Error(
        `${context} must define exactly one of "noticeFile", "noticeFiles", or "generatedNotices".`,
      );
    }
    return {
      name: readRequiredString(entry, "name", context),
      license: readRequiredString(entry, "license", context),
      ...(noticeFile !== undefined ? { noticeFiles: [noticeFile] } : {}),
      ...(noticeFiles !== undefined ? { noticeFiles } : {}),
      ...(generatedNotices !== undefined ? { generatedNotices } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
      ...(bundles !== undefined ? { bundles } : {}),
      ...(nativeDependencies !== undefined ? { nativeDependencies } : {}),
    };
  });
}

function decodePackageOverrides(value: unknown): ReadonlyArray<PackageNoticeOverrideConfigEntry> {
  return readArray(value, "packageOverrides").map((entry, index) => {
    const context = `Third-party package override at index ${String(index)}`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
    const name = readOptionalString(entry, "name", context);
    const repositoryUrl = readOptionalString(entry, "repositoryUrl", context);
    if ((name === undefined) === (repositoryUrl === undefined)) {
      throw new Error(`${context} must define exactly one of "name" or "repositoryUrl".`);
    }
    const version = readOptionalString(entry, "version", context);
    const license = readOptionalString(entry, "license", context);
    const noticeFile = readOptionalString(entry, "noticeFile", context);
    const generatedNotice =
      entry.generatedNotice === undefined
        ? undefined
        : decodeGeneratedNotice(entry.generatedNotice, `${context} generated notice`);
    const generatedNotices = decodeGeneratedNotices(entry.generatedNotices, context);
    if (
      Number(noticeFile !== undefined) +
        Number(generatedNotice !== undefined) +
        Number(generatedNotices !== undefined) >
      1
    ) {
      throw new Error(
        `${context} can define only one of "noticeFile", "generatedNotice", or "generatedNotices".`,
      );
    }
    const sourceUrl = readOptionalString(entry, "sourceUrl", context);
    return {
      ...(name !== undefined ? { name } : {}),
      ...(repositoryUrl !== undefined ? { repositoryUrl } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(license !== undefined ? { license } : {}),
      ...(noticeFile !== undefined ? { noticeFile } : {}),
      ...(generatedNotice !== undefined ? { generatedNotices: [generatedNotice] } : {}),
      ...(generatedNotices !== undefined ? { generatedNotices } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    };
  });
}

function decodeBundledDevDependencies(
  value: unknown,
): ReadonlyArray<BundledDevDependenciesConfigEntry> {
  return readArray(value, "bundledDevDependencies").map((entry, index) => {
    const context = `Third-party bundled dev dependencies at index ${String(index)}`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
    return {
      bundle: readRequiredString(entry, "bundle", context),
      names: readOptionalStringArray(entry, "names", context) ?? [],
      packageManifest: readRequiredString(entry, "packageManifest", context),
      reason: readRequiredString(entry, "reason", context),
    };
  });
}

function decodeBuildOnlyDependencies(
  value: unknown,
): ReadonlyArray<BuildOnlyDependenciesConfigEntry> {
  return readArray(value, "buildOnlyDependencies").map((entry, index) => {
    const context = `Third-party build-only dependencies at index ${String(index)}`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
    return {
      from: readRequiredString(entry, "from", context),
      names: readOptionalStringArray(entry, "names", context) ?? [],
      reason: readRequiredString(entry, "reason", context),
    };
  });
}

function decodeReviewedLicenses(value: unknown): ReadonlyArray<ReviewedLicense> {
  return readArray(value, "reviewedLicenses").map((entry, index) => {
    const context = `Third-party reviewed license at index ${String(index)}`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
    return {
      name: readRequiredString(entry, "name", context),
      license: readRequiredString(entry, "license", context),
      reason: readRequiredString(entry, "reason", context),
    };
  });
}

function decodeNativeDependencyExclusions(
  value: unknown,
): ReadonlyArray<NativeDependencyExclusion> {
  return readArray(value, "nativeDependencyExclusions").map((entry, index) => {
    const context = `Third-party native dependency exclusion at index ${String(index)}`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
    return {
      id: readRequiredString(entry, "id", context),
      reason: readRequiredString(entry, "reason", context),
    };
  });
}

export async function readThirdPartyLicensesConfig(configFile: string | URL | undefined): Promise<{
  readonly config: ThirdPartyLicensesConfig;
  readonly directory: string;
}> {
  if (configFile === undefined) {
    return { config: EMPTY_CONFIG, directory: NodePath.resolve(".") };
  }
  const configPath = asPath(configFile);
  const source = await NodeFSP.readFile(configPath, "utf8");
  const decoded = JSON.parse(source) as unknown;
  if (!isRecord(decoded)) throw new Error("Third-party license config must contain an object.");
  return {
    config: {
      buildOnlyDependencies: decodeBuildOnlyDependencies(decoded.buildOnlyDependencies),
      bundledDevDependencies: decodeBundledDevDependencies(decoded.bundledDevDependencies),
      customNotices: decodeCustomNotices(decoded.customNotices),
      nativeDependencyExclusions: decodeNativeDependencyExclusions(
        decoded.nativeDependencyExclusions,
      ),
      packageOverrides: decodePackageOverrides(decoded.packageOverrides),
      reviewedLicenses: decodeReviewedLicenses(decoded.reviewedLicenses),
    },
    directory: NodePath.dirname(configPath),
  };
}

function spdxTemplatePath(configDirectory: string, licenseId: string): string {
  return NodePath.join(
    configDirectory,
    SPDX_TEMPLATE_DIRECTORY,
    SPDX_LICENSE_LIST_VERSION,
    `${licenseId}.json`,
  );
}

function decodeSpdxLicenseDetails(value: unknown, expectedLicenseId: string): SpdxLicenseDetails {
  if (
    !isRecord(value) ||
    value.licenseId !== expectedLicenseId ||
    typeof value.licenseText !== "string" ||
    value.licenseText.trim().length === 0
  ) {
    throw new Error(`SPDX returned invalid license details for ${expectedLicenseId}.`);
  }
  return { licenseId: expectedLicenseId, licenseText: value.licenseText.trim() };
}

async function readSpdxLicense(
  configDirectory: string,
  licenseId: string,
): Promise<SpdxLicenseDetails | null> {
  try {
    const source = await NodeFSP.readFile(spdxTemplatePath(configDirectory, licenseId), "utf8");
    return decodeSpdxLicenseDetails(JSON.parse(source) as unknown, licenseId);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function downloadSpdxLicense(configDirectory: string, licenseId: string): Promise<void> {
  const url = `https://raw.githubusercontent.com/spdx/license-list-data/${SPDX_LICENSE_LIST_REVISION}/json/details/${encodeURIComponent(licenseId)}.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not download SPDX license ${licenseId}: HTTP ${String(response.status)}.`,
    );
  }
  const details = decodeSpdxLicenseDetails((await response.json()) as unknown, licenseId);
  const templatePath = spdxTemplatePath(configDirectory, licenseId);
  await NodeFSP.mkdir(NodePath.dirname(templatePath), { recursive: true });
  await NodeFSP.writeFile(templatePath, `${JSON.stringify(details, null, 2)}\n`, "utf8");
}

function renderGeneratedNotice(config: GeneratedNoticeConfigEntry, licenseText: string): string {
  const copyrights = config.copyrights ?? [];
  let renderedLicense = licenseText;
  if (copyrights.length > 0) {
    const placeholderPattern = /^Copyright[^\n]*(?:<year>|<copyright holders>|<owner>)[^\n]*$/m;
    if (placeholderPattern.test(renderedLicense)) {
      renderedLicense = renderedLicense.replace(placeholderPattern, copyrights.join("\n"));
    } else if (config.licenseId === "ISC") {
      renderedLicense = renderedLicense.replace(
        /^(?:Copyright[^\n]*\n)+/m,
        `${copyrights.join("\n")}\n`,
      );
    } else {
      renderedLicense = `${copyrights.join("\n")}\n\n${renderedLicense}`;
    }
  }
  return [...(config.preamble ?? []), renderedLicense].join("\n\n").trim();
}

async function generatedNoticeText(
  configs: ReadonlyArray<GeneratedNoticeConfigEntry>,
  configDirectory: string,
): Promise<string> {
  const sections = await Promise.all(
    configs.map(async (config) => {
      const details = await readSpdxLicense(configDirectory, config.licenseId);
      if (!details) {
        throw new Error(
          `SPDX license template ${config.licenseId} is missing. Run \`node scripts/sync-third-party-license-notices.ts\` and commit ${SPDX_TEMPLATE_DIRECTORY}.`,
        );
      }
      return renderGeneratedNotice(config, details.licenseText);
    }),
  );
  return sections.join("\n\n---\n\n");
}

/** Downloads every SPDX template the config names that is not committed yet. */
export async function syncThirdPartyLicenseNotices(configFile: string | URL): Promise<void> {
  const { config, directory } = await readThirdPartyLicensesConfig(configFile);
  const licenseIds = [
    ...new Set(
      [
        ...config.customNotices.flatMap((notice) => notice.generatedNotices ?? []),
        ...config.packageOverrides.flatMap((override) => override.generatedNotices ?? []),
      ].map((notice) => notice.licenseId),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  await Promise.all(
    licenseIds.map(async (licenseId) => {
      if (!(await readSpdxLicense(directory, licenseId))) {
        await downloadSpdxLicense(directory, licenseId);
      }
    }),
  );
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
  const source = await NodeFSP.readFile(packageJsonPath, "utf8");
  const value = JSON.parse(source) as unknown;
  if (!isRecord(value)) throw new Error(`Package manifest is not an object: ${packageJsonPath}`);
  return value as PackageJson;
}

function packageName(packageJson: PackageJson, packageRoot: string): string {
  return typeof packageJson.name === "string" ? packageJson.name : NodePath.basename(packageRoot);
}

function packageVersion(packageJson: PackageJson): string {
  return typeof packageJson.version === "string" ? packageJson.version : "unknown";
}

function packageIdentity(packageJson: PackageJson, packageRoot: string): string {
  return `${packageName(packageJson, packageRoot)}@${packageVersion(packageJson)}`;
}

async function findPackageRoot(
  resolvedPath: string,
  expectedName?: string,
): Promise<{ readonly packageJson: PackageJson; readonly packageRoot: string } | null> {
  let current = NodePath.dirname(resolvedPath);
  const root = NodePath.parse(current).root;

  while (current !== root) {
    const packageJsonPath = NodePath.join(current, "package.json");
    try {
      const packageJson = await readPackageJson(packageJsonPath);
      const matchesExpectedPackage =
        expectedName !== undefined
          ? packageJson.name === expectedName
          : typeof packageJson.name === "string" && typeof packageJson.version === "string";
      if (matchesExpectedPackage) {
        return { packageJson, packageRoot: await NodeFSP.realpath(current) };
      }
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    current = NodePath.dirname(current);
  }
  return null;
}

async function resolveDependencyPackage(
  dependencyName: string,
  fromPackageJsonPath: string,
): Promise<{ readonly packageJson: PackageJson; readonly packageRoot: string } | null> {
  const requireFromPackage = NodeModule.createRequire(fromPackageJsonPath);
  for (const candidate of [`${dependencyName}/package.json`, dependencyName]) {
    try {
      const resolved = requireFromPackage.resolve(candidate);
      const found = await findPackageRoot(resolved, dependencyName);
      if (found) return found;
    } catch (error) {
      const code = errorCode(error);
      if (code !== "MODULE_NOT_FOUND" && code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    }
  }

  let current = NodePath.dirname(fromPackageJsonPath);
  const root = NodePath.parse(current).root;
  while (true) {
    const packageRoot = NodePath.join(current, "node_modules", dependencyName);
    try {
      const packageJson = await readPackageJson(NodePath.join(packageRoot, "package.json"));
      if (packageJson.name === dependencyName) {
        return { packageJson, packageRoot: await NodeFSP.realpath(packageRoot) };
      }
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    if (current === root) break;
    current = NodePath.dirname(current);
  }
  return null;
}

function dependencyNames(packageJson: PackageJson): ReadonlyArray<string> {
  return [
    ...new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ]),
  ].toSorted((left, right) => left.localeCompare(right));
}

interface ExportTarget {
  readonly path: string;
  readonly underTypesCondition: boolean;
}

function exportTargets(value: unknown, underTypesCondition = false): ReadonlyArray<ExportTarget> {
  if (typeof value === "string") return [{ path: value, underTypesCondition }];
  if (Array.isArray(value))
    return value.flatMap((item) => exportTargets(item, underTypesCondition));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    exportTargets(item, underTypesCondition || key.startsWith("types") || key === "typings"),
  );
}

function isTypeDeclaration(target: ExportTarget): boolean {
  return (
    target.underTypesCondition ||
    /\.d\.[cm]?ts$/u.test(target.path) ||
    target.path === "./package.json"
  );
}

function isDeclared(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
}

/** Type declarations plus no JS entry mean nothing ships; a types name/condition alone does not prove that. */
async function isTypeOnlyPackage(packageJson: PackageJson, packageRoot: string): Promise<boolean> {
  const targets = exportTargets(packageJson.exports);
  const declaresTypes =
    isDeclared(packageJson.types) ||
    isDeclared(packageJson.typings) ||
    targets.some(isTypeDeclaration);
  if (!declaresTypes) return false;
  const entries = [
    packageJson.main,
    packageJson.module,
    packageJson.browser,
    packageJson["react-native"],
    packageJson.bin,
    packageJson.style,
    packageJson.sass,
  ];
  if (entries.some(isDeclared) || targets.some((target) => !isTypeDeclaration(target))) {
    return false;
  }
  // Without `exports`, Node still loads the package's index file, an empty `main` included.
  if (packageJson.exports !== undefined && packageJson.exports !== null) return true;
  for (const indexFile of ["index.js", "index.json", "index.node"]) {
    if (await fileExists(NodePath.join(packageRoot, indexFile))) return false;
  }
  return true;
}

interface CollectionRoot {
  readonly bundle: string;
  readonly packageJsonPath: string;
  /** Visit only these dependencies of the manifest (its dev dependencies inlined into a build). */
  readonly only?: ReadonlyArray<string>;
}

function matchesName(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

function isBuildOnlyDependency(
  rules: ReadonlyArray<BuildOnlyDependenciesConfigEntry>,
  from: string,
  dependencyName: string,
): boolean {
  return rules.some(
    (rule) =>
      (rule.from === "*" || rule.from === from) &&
      rule.names.some((pattern) => matchesName(pattern, dependencyName)),
  );
}

async function collectProductionDependencyPackages(
  roots: ReadonlyArray<CollectionRoot>,
  buildOnly: ReadonlyArray<BuildOnlyDependenciesConfigEntry>,
): Promise<PackageCollection> {
  const collection: PackageCollection = { byIdentity: new Map() };
  const visited = new Set<string>();

  const visitDependency = async (
    dependencyName: string,
    fromPackageJsonPath: string,
    bundle: string,
  ): Promise<void> => {
    const resolved = await resolveDependencyPackage(dependencyName, fromPackageJsonPath);
    if (!resolved) {
      if (fromPackageJsonPath.split(NodePath.sep).includes("node_modules")) return;
      // A package Ryco itself declares must be installed; skipping it would drop its notice.
      throw new Error(
        `${dependencyName} (declared in ${fromPackageJsonPath}) is not installed. Run \`bun install --frozen-lockfile\`.`,
      );
    }
    // Checked and recorded before the next await, so concurrent branches visit a package once.
    const visitKey = `${bundle}:${resolved.packageRoot}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    const name = packageName(resolved.packageJson, resolved.packageRoot);
    // Type-only and first-party packages get no row, but what they depend on may ship.
    if (
      !isFirstPartyPackage(name, resolved.packageRoot) &&
      !(await isTypeOnlyPackage(resolved.packageJson, resolved.packageRoot))
    ) {
      const identity = packageIdentity(resolved.packageJson, resolved.packageRoot);
      const existing = collection.byIdentity.get(identity);
      if (existing) {
        existing.bundles.add(bundle);
      } else {
        collection.byIdentity.set(identity, {
          bundles: new Set([bundle]),
          packageJson: resolved.packageJson,
          packageRoot: resolved.packageRoot,
        });
      }
    }
    await visitManifest(NodePath.join(resolved.packageRoot, "package.json"), bundle);
  };

  const visitManifest = async (
    packageJsonPath: string,
    bundle: string,
    only?: ReadonlyArray<string>,
  ): Promise<void> => {
    const packageJson = await readPackageJson(packageJsonPath);
    const from = packageName(packageJson, NodePath.dirname(packageJsonPath));
    const names = (only ?? dependencyNames(packageJson)).filter(
      (dependencyName) => !isBuildOnlyDependency(buildOnly, from, dependencyName),
    );
    await Promise.all(
      names.map((dependencyName) => visitDependency(dependencyName, packageJsonPath, bundle)),
    );
  };

  await Promise.all(
    roots.map((root) => visitManifest(root.packageJsonPath, root.bundle, root.only)),
  );
  return collection;
}

function collectionRoots(
  packageManifests: ReadonlyArray<ThirdPartyLicensePackageManifest>,
  config: ThirdPartyLicensesConfig,
  configDirectory: string,
): ReadonlyArray<CollectionRoot> {
  const bundles = new Set(packageManifests.map((manifest) => manifest.bundle));
  return [
    ...packageManifests.map((manifest) => ({
      bundle: manifest.bundle,
      packageJsonPath: asPath(manifest.path),
    })),
    ...config.bundledDevDependencies
      .filter((entry) => bundles.has(entry.bundle))
      .map((entry) => ({
        bundle: entry.bundle,
        packageJsonPath: NodePath.resolve(configDirectory, entry.packageManifest),
        only: entry.names,
      })),
  ];
}

/** The third-party packages a client ships, keyed by `name@version`. */
export async function collectThirdPartyPackages(input: {
  readonly configFile?: string | URL;
  readonly packageManifests: ReadonlyArray<ThirdPartyLicensePackageManifest>;
}): Promise<ReadonlyMap<string, CollectedPackage>> {
  const { config, directory } = await readThirdPartyLicensesConfig(input.configFile);
  const collection = await collectProductionDependencyPackages(
    collectionRoots(input.packageManifests, config, directory),
    config.buildOnlyDependencies,
  );
  return collection.byIdentity;
}

function normalizeLicense(packageJson: PackageJson): string | null {
  if (typeof packageJson.license === "string" && packageJson.license.trim().length > 0) {
    return packageJson.license.trim();
  }
  if (isRecord(packageJson.license) && typeof packageJson.license.type === "string") {
    return packageJson.license.type.trim() || null;
  }
  const declaredLicenses = Array.isArray(packageJson.license)
    ? packageJson.license
    : packageJson.licenses;
  if (Array.isArray(declaredLicenses)) {
    const licenses = declaredLicenses
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (isRecord(entry) && typeof entry.type === "string") return entry.type.trim();
        return "";
      })
      .filter((entry) => entry.length > 0);
    if (licenses.length > 0) return licenses.join(" OR ");
  }
  return null;
}

function normalizeRepositoryUrl(value: unknown): string | null {
  const raw =
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.url === "string"
        ? value.url
        : null;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("github:")) return `https://github.com/${trimmed.slice(7)}`;
  const normalized = trimmed
    .replace(/^git\+ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/(?:git@)?github\.com\//, "https://github.com/")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/^http:\/\/github\.com\//, "https://github.com/")
    .replace(/#.*$/, "")
    .replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(normalized)) return `https://github.com/${normalized}`;
  return normalized;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/u.test(value);
}

function packageSourceUrl(packageJson: PackageJson): string | null {
  const homepage =
    typeof packageJson.homepage === "string" ? packageJson.homepage.trim() : undefined;
  if (homepage && isHttpUrl(homepage)) return homepage;
  const repository = normalizeRepositoryUrl(packageJson.repository);
  return repository && isHttpUrl(repository) ? repository : null;
}

async function readPackageNoticeText(packageRoot: string): Promise<string | null> {
  const noticeFiles: string[] = [];
  const rootEntries = await NodeFSP.readdir(packageRoot, { withFileTypes: true });
  noticeFiles.push(
    ...rootEntries
      .filter((entry) => entry.isFile() && isNoticeTextFile(entry.name))
      .map((entry) => entry.name),
  );

  const collectNestedNoticeFiles = async (directory: string, depth: number): Promise<void> => {
    const directoryEntries = await NodeFSP.readdir(NodePath.join(packageRoot, directory), {
      withFileTypes: true,
    });
    await Promise.all(
      directoryEntries.map(async (entry) => {
        const relativePath = NodePath.join(directory, entry.name);
        if (entry.isFile() && isNoticeTextFile(entry.name)) {
          noticeFiles.push(relativePath);
          return;
        }
        if (
          depth > 0 &&
          entry.isDirectory() &&
          entry.name !== "node_modules" &&
          entry.name !== ".git"
        ) {
          await collectNestedNoticeFiles(relativePath, depth - 1);
        }
      }),
    );
  };
  await Promise.all(
    rootEntries
      .filter(
        (entry) => entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git",
      )
      .map((entry) => collectNestedNoticeFiles(entry.name, 2)),
  );
  noticeFiles.sort((left, right) => left.localeCompare(right));
  if (noticeFiles.length === 0) return null;

  const sections: string[] = [];
  for (const fileName of noticeFiles) {
    const contents = (await NodeFSP.readFile(NodePath.join(packageRoot, fileName), "utf8")).trim();
    if (contents.length === 0) continue;
    sections.push(noticeFiles.length === 1 ? contents : `${fileName}\n\n${contents}`);
  }
  return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
}

function repositoryNoticeKey(packageJson: PackageJson, license: string): string | null {
  const repositoryUrl = normalizeRepositoryUrl(packageJson.repository);
  return repositoryUrl ? `${repositoryUrl.toLowerCase()}\n${license.toLowerCase()}` : null;
}

function packageNoticeText(
  packageRoot: string,
  cache: Map<string, Promise<string | null>>,
): Promise<string | null> {
  const existing = cache.get(packageRoot);
  if (existing) return existing;
  const notice = readPackageNoticeText(packageRoot);
  cache.set(packageRoot, notice);
  return notice;
}

async function collectRepositoryNotices(
  collection: PackageCollection,
  packageNotices: Map<string, Promise<string | null>>,
): Promise<ReadonlyMap<string, string>> {
  const notices = new Map<string, string>();
  const candidates = await Promise.all(
    [...collection.byIdentity.values()].map(async (collected) => {
      const license = normalizeLicense(collected.packageJson);
      if (!license) return null;
      const key = repositoryNoticeKey(collected.packageJson, license);
      if (!key) return null;
      const noticeText = await packageNoticeText(collected.packageRoot, packageNotices);
      return noticeText ? { key, noticeText } : null;
    }),
  );
  for (const candidate of candidates) {
    if (candidate && !notices.has(candidate.key)) notices.set(candidate.key, candidate.noticeText);
  }
  return notices;
}

function findPackageOverride(
  overrides: ReadonlyArray<PackageNoticeOverrideConfigEntry>,
  name: string,
  version: string,
  packageJson: PackageJson,
): PackageNoticeOverrideConfigEntry | undefined {
  const repositoryUrl = normalizeRepositoryUrl(packageJson.repository)?.toLowerCase();
  const matchesRepository = (override: PackageNoticeOverrideConfigEntry) =>
    repositoryUrl !== undefined &&
    override.repositoryUrl !== undefined &&
    normalizeRepositoryUrl(override.repositoryUrl)?.toLowerCase() === repositoryUrl;
  return (
    overrides.find((override) => override.name === name && override.version === version) ??
    overrides.find((override) => override.name === name && override.version === undefined) ??
    overrides.find((override) => matchesRepository(override) && override.version === version) ??
    overrides.find((override) => matchesRepository(override) && override.version === undefined)
  );
}

async function packageEntry(
  collected: CollectedPackage,
  config: ThirdPartyLicensesConfig,
  configDirectory: string,
  packageNotices: Map<string, Promise<string | null>>,
  repositoryNotices: ReadonlyMap<string, string>,
): Promise<ThirdPartyLicenseEntry> {
  const name = packageName(collected.packageJson, collected.packageRoot);
  const version = packageVersion(collected.packageJson);
  const override = findPackageOverride(
    config.packageOverrides,
    name,
    version,
    collected.packageJson,
  );
  const declaredLicense = override?.license ?? normalizeLicense(collected.packageJson);
  const license = declaredLicense ? normalizeLicenseExpression(declaredLicense) : null;
  if (!license || /^(?:unlicensed|proprietary)$/i.test(license)) {
    throw new Error(
      `${name}@${version} does not declare a distributable license. Add a package override in the third-party license config if the package publishes its notice elsewhere.`,
    );
  }
  const violation = licensePolicyViolation({ name, license }, config.reviewedLicenses);
  if (violation) throw new Error(`${name}@${version}: ${violation}`);

  const repositoryKey = repositoryNoticeKey(collected.packageJson, declaredLicense ?? license);
  const noticeText = override?.generatedNotices
    ? await generatedNoticeText(override.generatedNotices, configDirectory)
    : override?.noticeFile
      ? (
          await NodeFSP.readFile(NodePath.resolve(configDirectory, override.noticeFile), "utf8")
        ).trim()
      : ((await packageNoticeText(collected.packageRoot, packageNotices)) ??
        (repositoryKey ? repositoryNotices.get(repositoryKey) : undefined));
  if (!noticeText) {
    throw new Error(
      `${name}@${version} does not include a license or notice file. Add a package override with "noticeFile" or "generatedNotice" in the third-party license config.`,
    );
  }

  return {
    bundles: [...collected.bundles].toSorted((left, right) => left.localeCompare(right)),
    kind: "package",
    license,
    name,
    noticeText,
    sourceUrl: override?.sourceUrl ?? packageSourceUrl(collected.packageJson),
    version,
  };
}

async function customEntries(
  config: ThirdPartyLicensesConfig,
  configDirectory: string,
  includedBundles: ReadonlySet<string>,
): Promise<ReadonlyArray<ThirdPartyLicenseEntry>> {
  return Promise.all(
    config.customNotices
      .filter(
        (notice) =>
          notice.bundles === undefined ||
          notice.bundles.some((bundle) => includedBundles.has(bundle)),
      )
      .map(async (notice) => {
        const violation = licensePolicyViolation(notice, config.reviewedLicenses);
        if (violation) throw new Error(`Custom third-party notice: ${violation}`);
        const noticeText = notice.generatedNotices
          ? await generatedNoticeText(notice.generatedNotices, configDirectory)
          : (
              await Promise.all(
                (notice.noticeFiles ?? []).map(async (noticeFile) => {
                  const contents = (
                    await NodeFSP.readFile(NodePath.resolve(configDirectory, noticeFile), "utf8")
                  ).trim();
                  if (contents.length === 0) {
                    throw new Error(`Custom third-party notice "${notice.name}" is empty.`);
                  }
                  return contents;
                }),
              )
            ).join("\n\n---\n\n");
        if (noticeText.length === 0) {
          throw new Error(`Custom third-party notice "${notice.name}" is empty.`);
        }
        return {
          bundles: [...(notice.bundles ?? ["assets"])].toSorted((left, right) =>
            left.localeCompare(right),
          ),
          kind: "custom" as const,
          license: notice.license,
          name: notice.name,
          noticeText,
          sourceUrl: notice.sourceUrl ?? null,
          version: notice.version ?? null,
        };
      }),
  );
}

function entrySort(left: ThirdPartyLicenseEntry, right: ThirdPartyLicenseEntry): number {
  return (
    left.name.localeCompare(right.name, "en", { sensitivity: "base" }) ||
    left.name.localeCompare(right.name) ||
    (left.version ?? "").localeCompare(right.version ?? "") ||
    left.kind.localeCompare(right.kind)
  );
}

function assertUniqueEntries(entries: ReadonlyArray<ThirdPartyLicenseEntry>): void {
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = JSON.stringify([entry.kind, entry.name, entry.version]);
    if (identities.has(identity)) {
      throw new Error(
        `Third-party license generation found a duplicate ${entry.kind} notice for ${entry.name}${entry.version ? `@${entry.version}` : ""}.`,
      );
    }
    identities.add(identity);
  }
}

/**
 * The manifest for the clients named by `packageManifests`: their production and optional
 * dependency closure (workspace packages' dependencies included, Ryco's own packages omitted), the
 * dev dependencies the config says a build inlines, and the config's custom notices for those
 * bundles. Fails on a package without a distributable license or notice text, and on any license
 * the policy in `third-party-license-policy.ts` does not admit.
 */
export async function generateThirdPartyLicenseManifest(input: {
  readonly configFile?: string | URL;
  readonly packageManifests: ReadonlyArray<ThirdPartyLicensePackageManifest>;
  /** Custom notices for these bundles join the manifest; defaults to the manifests' bundles. */
  readonly customNoticeBundles?: ReadonlyArray<string>;
}): Promise<ThirdPartyLicenseManifest> {
  const { config, directory } = await readThirdPartyLicensesConfig(input.configFile);
  const collection = await collectProductionDependencyPackages(
    collectionRoots(input.packageManifests, config, directory),
    config.buildOnlyDependencies,
  );

  const packageNotices = new Map<string, Promise<string | null>>();
  const repositoryNotices = await collectRepositoryNotices(collection, packageNotices);

  const packageEntryResults = await Promise.allSettled(
    [...collection.byIdentity.values()].map((collected) =>
      packageEntry(collected, config, directory, packageNotices, repositoryNotices),
    ),
  );
  const failures = packageEntryResults.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : [],
  );
  if (failures.length > 0) {
    throw new Error(
      `Third-party license generation found ${String(failures.length)} invalid package notice${failures.length === 1 ? "" : "s"}:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }
  const packageEntries = packageEntryResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const includedBundles = new Set(
    input.customNoticeBundles ?? input.packageManifests.map((manifest) => manifest.bundle),
  );
  const manualEntries = await customEntries(config, directory, includedBundles);
  const entries = [...packageEntries, ...manualEntries].toSorted(entrySort);
  assertUniqueEntries(entries);
  return { schemaVersion: 1, entries };
}

/**
 * The npm packages among a bundle's module files that the manifest does not list, as
 * `name@version`. Ryco's own packages and files outside node_modules never count. Metro's
 * production serializer runs this so a release bundle cannot ship code without its notice.
 */
export async function findUnlistedBundledPackages(
  manifest: {
    readonly entries: ReadonlyArray<Pick<ThirdPartyLicenseEntry, "kind" | "name" | "version">>;
  },
  modulePaths: Iterable<string>,
): Promise<ReadonlyArray<string>> {
  const listed = new Set(
    manifest.entries
      .filter((entry) => entry.kind === "package")
      .map((entry) => `${entry.name}@${entry.version ?? ""}`),
  );
  const packageByDirectory = new Map<string, Promise<string | null>>();
  const packageOf = (directory: string): Promise<string | null> => {
    const cached = packageByDirectory.get(directory);
    if (cached) return cached;
    const found = findPackageRoot(NodePath.join(directory, "index.js")).then((result) =>
      result &&
      typeof result.packageJson.name === "string" &&
      !isFirstPartyPackage(result.packageJson.name, result.packageRoot)
        ? packageIdentity(result.packageJson, result.packageRoot)
        : null,
    );
    packageByDirectory.set(directory, found);
    return found;
  };
  const identities = await Promise.all(
    [...new Set(modulePaths)]
      .filter(
        (path) => NodePath.isAbsolute(path) && path.split(NodePath.sep).includes("node_modules"),
      )
      .map((path) => packageOf(NodePath.dirname(path))),
  );
  return [...new Set(identities)]
    .filter((identity): identity is string => identity !== null && !listed.has(identity))
    .toSorted((left, right) => left.localeCompare(right));
}
