import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DesktopAppSnapSettingsPane } from "@ryco/contracts";

const BUNDLE_IDENTIFIER_PATTERN = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/;
const DEFAULT_BUNDLE_IDENTIFIER = "com.laurinfrank.ryco";

/**
 * The app bundle's identifier, read from its Info.plist. Bundles are written
 * as XML plists, so this is a file read rather than a PlistBuddy process on the
 * startup path; a binary plist (rare, hand-edited bundles) still uses it.
 */
export function readBundleIdentifier(
  infoPlistPath: string,
  readFile: (path: string) => Buffer = (path) => readFileSync(path),
): string | null {
  try {
    const contents = readFile(infoPlistPath);
    if (contents.subarray(0, 6).toString("latin1") !== "bplist") {
      return BUNDLE_IDENTIFIER_PATTERN.exec(contents.toString("utf8"))?.[1]?.trim() || null;
    }
    return (
      execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print:CFBundleIdentifier", infoPlistPath], {
        encoding: "utf8",
        timeout: 1000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * The running app's bundle as the native helpers see it: its path when the
 * executable lives in one (permission setup registers that exact copy), and
 * the identifier whose windows capture excludes.
 */
export function resolveMacAppBundle(
  executablePath: string,
  platform: NodeJS.Platform,
  readIdentifier: (infoPlistPath: string) => string | null = readBundleIdentifier,
): { readonly bundlePath: string | undefined; readonly bundleId: string } {
  const appEnd = executablePath.indexOf(".app/");
  const bundlePath = appEnd >= 0 ? executablePath.slice(0, appEnd + 4) : undefined;
  const bundleId =
    bundlePath && platform === "darwin"
      ? (readIdentifier(join(bundlePath, "Contents", "Info.plist")) ?? DEFAULT_BUNDLE_IDENTIFIER)
      : DEFAULT_BUNDLE_IDENTIFIER;
  return { bundlePath, bundleId };
}

const PRIVACY_PANE_ANCHORS: Record<DesktopAppSnapSettingsPane, string> = {
  accessibility: "Accessibility",
  "input-monitoring": "ListenEvent",
  "screen-recording": "ScreenCapture",
};

/** System Settings deep link for one macOS privacy pane. */
export function macPrivacySettingsUrl(pane: DesktopAppSnapSettingsPane): string {
  return `x-apple.systempreferences:com.apple.preference.security?Privacy_${PRIVACY_PANE_ANCHORS[pane]}`;
}
