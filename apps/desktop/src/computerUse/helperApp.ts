import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  COMPUTER_USE_HELPER_CONTENTS_DIRECTORY,
  COMPUTER_USE_HELPER_PROTOCOL,
  COMPUTER_USE_HELPER_PROTOCOL_KEY,
} from "@ryco/shared/computerUseHelperApp";

/** Ryco Computer Use as found on disk: the bundle macOS gives Computer Use's grants to. */
export interface ComputerUseHelperApp {
  readonly bundlePath: string;
  readonly bundleId: string;
  /** The name System Settings lists. */
  readonly displayName: string;
  /** `CFBundleShortVersionString`; the running helper must report exactly this. */
  readonly version: string;
}

export interface HelperAppFileSystem {
  readDirectory(path: string): readonly string[];
  readFile(path: string): Buffer;
}

const nodeFileSystem: HelperAppFileSystem = {
  readDirectory: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path),
};

/** Top-level `<key>…</key><string|integer>…</…>` values of an XML or binary Info.plist. */
export function readInfoPlist(
  path: string,
  fileSystem: HelperAppFileSystem = nodeFileSystem,
): Record<string, string> | undefined {
  let contents: Buffer;
  try {
    contents = fileSystem.readFile(path);
  } catch {
    return undefined;
  }
  let xml = contents.toString("utf8");
  if (contents.subarray(0, 6).toString("latin1") === "bplist") {
    try {
      xml = execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", path], {
        encoding: "utf8",
        timeout: 1000,
      });
    } catch {
      return undefined;
    }
  }
  const values: Record<string, string> = {};
  for (const match of xml.matchAll(
    /<key>([^<]+)<\/key>\s*<(string|integer)>([^<]*)<\/(?:string|integer)>/g,
  ))
    values[match[1]!] = match[3]!.trim();
  return values;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

/**
 * Finds Ryco Computer Use for the running app. A packaged Ryco carries it in
 * `Contents/Helpers`; the dev launcher keeps it beside its wrapper bundle. A bundle counts only
 * when its Info.plist declares this build's helper protocol, so a renamed copy still works and
 * nothing else in that directory is ever mistaken for it.
 */
export function findComputerUseHelperApp(input: {
  readonly hostBundlePath: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly fileSystem?: HelperAppFileSystem;
}): ComputerUseHelperApp | undefined {
  if (input.platform !== "darwin" || !input.hostBundlePath) return undefined;
  // Escape hatch for diagnosis: run Computer Use under Ryco itself, as before the helper.
  if (input.env?.RYCO_COMPUTER_USE_HELPER_APP === "0") return undefined;
  const fileSystem = input.fileSystem ?? nodeFileSystem;
  const directory = input.isPackaged
    ? join(input.hostBundlePath, "Contents", COMPUTER_USE_HELPER_CONTENTS_DIRECTORY)
    : dirname(input.hostBundlePath);
  let entries: readonly string[];
  try {
    entries = fileSystem.readDirectory(directory);
  } catch {
    return undefined;
  }
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith(".app") || entry.startsWith(".")) continue;
    const bundlePath = join(directory, entry);
    if (bundlePath === input.hostBundlePath) continue;
    const info = readInfoPlist(join(bundlePath, "Contents", "Info.plist"), fileSystem);
    if (!info || info[COMPUTER_USE_HELPER_PROTOCOL_KEY] !== String(COMPUTER_USE_HELPER_PROTOCOL))
      continue;
    const bundleId = info.CFBundleIdentifier;
    const version = info.CFBundleShortVersionString;
    if (!bundleId || !version) continue;
    return {
      bundlePath,
      bundleId: unescapeXml(bundleId),
      displayName: unescapeXml(info.CFBundleDisplayName || info.CFBundleName || entry.slice(0, -4)),
      version: unescapeXml(version),
    };
  }
  return undefined;
}
