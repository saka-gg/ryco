#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const VERSION = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "12.17.0";
const VERSION_TAG = `v${VERSION}`;
const VSIX_URL = `https://open-vsx.org/api/vscode-icons-team/vscode-icons/${VERSION}/file/vscode-icons-team.vscode-icons-${VERSION}.vsix`;
const LANGUAGES_URL = `https://raw.githubusercontent.com/vscode-icons/vscode-icons/${VERSION_TAG}/src/iconsManifest/languages.ts`;

const REPO_ROOT = process.cwd();
// The web resolver reads this slim lookup (icon file per name, extension,
// folder and language) instead of the full theme manifest.
const LOOKUP_PATH = path.join(REPO_ROOT, "apps/web/src/vscode-icons-lookup.json");
// Icons are served by the app itself (never a third-party CDN), from a
// version-pinned path so they can be cached as immutable.
const ICONS_ROOT = path.join(REPO_ROOT, "apps/web/public/vscode-icons");
const ICONS_DIR = path.join(ICONS_ROOT, VERSION_TAG);
const DEFAULT_FILE_ICON = "default_file.svg";
const DEFAULT_FOLDER_ICON = "default_folder.svg";
// Sections the resolver reads; `*Expanded`, root folder and other variants
// are never shown, so their icons are not shipped.
const LOOKUP_SECTIONS = ["fileNames", "fileExtensions", "folderNames", "languageIds"];

function normalizeExtension(value) {
  return value.trim().toLowerCase().replace(/^\./, "");
}

function normalizeFileName(value) {
  return value.trim().toLowerCase();
}

function putIfAbsent(target, key, value) {
  if (!(key in target)) {
    target[key] = value;
  }
}

async function downloadVsix(tmpDir) {
  // `--vsix <path>` reuses an already downloaded package (offline resync).
  const vsixArgIndex = process.argv.indexOf("--vsix");
  if (vsixArgIndex !== -1 && process.argv[vsixArgIndex + 1]) {
    return path.resolve(process.argv[vsixArgIndex + 1]);
  }
  const vsixPath = path.join(tmpDir, `vscode-icons-${VERSION}.vsix`);
  const response = await fetch(VSIX_URL);
  if (!response.ok) {
    throw new Error(`Failed to download VSIX: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(vsixPath, bytes);
  return vsixPath;
}

async function extractManifestFromVsix(vsixPath) {
  const { stdout } = await execFileAsync("unzip", [
    "-p",
    vsixPath,
    "extension/dist/src/vsicons-icon-theme.json",
  ]);
  if (!stdout || stdout.trim().length === 0) {
    throw new Error("Could not extract vsicons-icon-theme.json from VSIX");
  }
  return JSON.parse(stdout);
}

async function loadLanguagesCollection() {
  const response = await fetch(LANGUAGES_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch languages.ts: ${response.status} ${response.statusText}`);
  }
  const rawSource = await response.text();
  const source = rawSource
    .replace(/^import[^;]+;\s*/gm, "")
    .replace(/export const languages(?:\s*:\s*[^=]+)?\s*=/, "const languages =")
    .replace(/\}\s*satisfies\s*Record<[^;]+>;/, "};");

  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source}\n;globalThis.__languages = languages;`, context);
  const languages = context.__languages;
  if (!languages || typeof languages !== "object") {
    throw new Error("Failed to parse languages.ts into a collection");
  }
  return languages;
}

function iconFileName(manifest, definitionKey) {
  const iconPath = definitionKey ? manifest.iconDefinitions[definitionKey]?.iconPath : undefined;
  if (!iconPath) return null;
  return iconPath.slice(iconPath.lastIndexOf("/") + 1);
}

/**
 * Keeps the resolver's semantics (lowercased keys, later duplicates win, the
 * light theme falls back to dark) but maps straight to icon indices, without
 * the `.svg` suffix, and keeps only the light entries that differ from dark.
 */
function buildSlimLookup(manifest, associations) {
  const icons = [];
  const iconIndex = new Map();
  const indexOf = (fileName) => {
    let index = iconIndex.get(fileName);
    if (index === undefined) {
      index = icons.length;
      icons.push(fileName);
      iconIndex.set(fileName, index);
    }
    return index;
  };
  indexOf(DEFAULT_FILE_ICON);
  indexOf(DEFAULT_FOLDER_ICON);

  const buildSection = (section, fallback) => {
    const result = {};
    for (const name of LOOKUP_SECTIONS) {
      const lookup = {};
      for (const [key, definitionKey] of Object.entries(section[name] ?? {})) {
        const fileName = iconFileName(manifest, definitionKey);
        if (fileName) lookup[key.toLowerCase()] = indexOf(fileName);
      }
      if (fallback) {
        for (const [key, index] of Object.entries(lookup)) {
          if (fallback[name][key] === index) delete lookup[key];
        }
      }
      result[name] = lookup;
    }
    for (const name of ["file", "folder"]) {
      const fileName = iconFileName(manifest, section[name]);
      if (fileName) result[name] = indexOf(fileName);
    }
    return result;
  };

  const lowercaseKeys = (source) => {
    const result = {};
    for (const [key, value] of Object.entries(source)) result[key.toLowerCase()] = value;
    return result;
  };

  const dark = buildSection(manifest, null);
  const light = buildSection(manifest.light ?? {}, dark);
  return {
    version: VERSION,
    icons: icons.map((fileName) => fileName.replace(/\.svg$/u, "")),
    dark,
    light,
    extensionToLanguageId: lowercaseKeys(associations.extensionToLanguageId),
    fileNameToLanguageId: lowercaseKeys(associations.fileNameToLanguageId),
  };
}

async function extractIcons(vsixPath, tmpDir, iconNames) {
  const extractDir = path.join(tmpDir, "vsix");
  await execFileAsync("unzip", [
    "-q",
    "-o",
    vsixPath,
    "extension/icons/*",
    "extension/LICENSE.txt",
    "-d",
    extractDir,
  ]);
  await fs.rm(ICONS_ROOT, { recursive: true, force: true });
  await fs.mkdir(ICONS_DIR, { recursive: true });
  for (const fileName of iconNames.map((name) => `${name}.svg`)) {
    await fs.copyFile(
      path.join(extractDir, "extension/icons", fileName),
      path.join(ICONS_DIR, fileName),
    );
  }
  // The icons are redistributed with the app, so their MIT notice ships too.
  await fs.copyFile(
    path.join(extractDir, "extension/LICENSE.txt"),
    path.join(ICONS_DIR, "LICENSE.txt"),
  );
}

function buildLanguageAssociations(manifest, languages) {
  const availableLanguageIds = new Set(Object.keys(manifest.languageIds ?? {}));
  const extensionToLanguageId = {};
  const fileNameToLanguageId = {};

  for (const entry of Object.values(languages)) {
    if (!entry || typeof entry !== "object") continue;
    const idsRaw = entry.ids;
    const ids = Array.isArray(idsRaw) ? idsRaw : [idsRaw];
    const knownExtensions = Array.isArray(entry.knownExtensions) ? entry.knownExtensions : [];
    const knownFilenames = Array.isArray(entry.knownFilenames) ? entry.knownFilenames : [];

    for (const idValue of ids) {
      if (typeof idValue !== "string") continue;
      const languageId = idValue.trim();
      if (languageId.length === 0) continue;
      if (!availableLanguageIds.has(languageId)) continue;

      for (const extensionValue of knownExtensions) {
        if (typeof extensionValue !== "string") continue;
        const extension = normalizeExtension(extensionValue);
        if (extension.length === 0) continue;
        putIfAbsent(extensionToLanguageId, extension, languageId);
      }

      for (const fileNameValue of knownFilenames) {
        if (typeof fileNameValue !== "string") continue;
        const fileName = normalizeFileName(fileNameValue);
        if (fileName.length === 0) continue;
        putIfAbsent(fileNameToLanguageId, fileName, languageId);
      }
    }
  }

  return {
    extensionToLanguageId,
    fileNameToLanguageId,
  };
}

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-vscode-icons-sync-"));
  try {
    const vsixPath = await downloadVsix(tmpDir);
    const manifest = await extractManifestFromVsix(vsixPath);
    const languages = await loadLanguagesCollection();
    const associations = buildLanguageAssociations(manifest, languages);
    const lookup = buildSlimLookup(manifest, associations);

    await extractIcons(vsixPath, tmpDir, lookup.icons);
    await fs.writeFile(LOOKUP_PATH, `${JSON.stringify(lookup)}\n`, "utf8");

    process.stdout.write(
      [
        `Synced vscode-icons ${VERSION}`,
        `lookup: ${LOOKUP_PATH}`,
        `icons: ${lookup.icons.length} in ${ICONS_DIR}`,
        `extension mappings: ${Object.keys(lookup.extensionToLanguageId).length}`,
        `filename mappings: ${Object.keys(lookup.fileNameToLanguageId).length}`,
      ].join("\n") + "\n",
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
