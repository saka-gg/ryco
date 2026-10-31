/**
 * updateInstallRecord - What the app was installing when it last quit.
 *
 * Written when the app hands a downloaded update to the installer: at an explicit Restart, and
 * at a normal quit while electron-updater is armed to install then (`automaticAppUpdates`). The
 * next launch settles it: running the target version means the update took effect ("Updated
 * to X"); still running the version it came from means the install did not apply, and that
 * version is not installed again in the background. The record stays then, so a later launch
 * still knows; anything else is stale and removed.
 *
 * Synchronous on purpose: Electron's final `quit` event cannot await a write.
 *
 * @module updateInstallRecord
 */
import * as FS from "node:fs";

import { writeFileAtomicallySync } from "./atomicFileWrite.ts";

export const DESKTOP_UPDATE_INSTALL_RECORD_FILE = "desktop-update-install.json";

const VERSION_MAX_LENGTH = 256;

export interface DesktopUpdateInstallRecord {
  readonly fromVersion: string;
  readonly targetVersion: string;
}

export type DesktopUpdateInstallOutcome =
  | { readonly kind: "updated"; readonly fromVersion: string; readonly version: string }
  | { readonly kind: "not-applied"; readonly version: string }
  | { readonly kind: "none" };

const versionText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= VERSION_MAX_LENGTH;

export function parseDesktopUpdateInstallRecord(text: string): DesktopUpdateInstallRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!versionText(record.fromVersion) || !versionText(record.targetVersion)) return null;
  if (record.fromVersion === record.targetVersion) return null;
  return { fromVersion: record.fromVersion, targetVersion: record.targetVersion };
}

/** What a record means for the version running now. */
export function resolveDesktopUpdateInstallOutcome(
  record: DesktopUpdateInstallRecord | null,
  currentVersion: string,
): DesktopUpdateInstallOutcome {
  if (record === null) return { kind: "none" };
  if (record.targetVersion === currentVersion) {
    return { kind: "updated", fromVersion: record.fromVersion, version: record.targetVersion };
  }
  if (record.fromVersion === currentVersion) {
    return { kind: "not-applied", version: record.targetVersion };
  }
  return { kind: "none" };
}

/** Records the install about to run; `false` when it could not be written. */
export function writeDesktopUpdateInstallRecord(
  filePath: string,
  record: DesktopUpdateInstallRecord,
): boolean {
  try {
    writeFileAtomicallySync(filePath, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function removeDesktopUpdateInstallRecord(filePath: string): void {
  try {
    FS.rmSync(filePath, { force: true });
  } catch {
    // A record that cannot be removed only repeats its notice or its skip.
  }
}

/**
 * Reads the record left by the last run and settles it for `currentVersion`: kept only while
 * the install it names did not apply.
 */
export function settleDesktopUpdateInstallRecord(
  filePath: string,
  currentVersion: string,
): DesktopUpdateInstallOutcome {
  let text: string;
  try {
    text = FS.readFileSync(filePath, "utf8");
  } catch {
    return { kind: "none" };
  }
  const outcome = resolveDesktopUpdateInstallOutcome(
    parseDesktopUpdateInstallRecord(text),
    currentVersion,
  );
  if (outcome.kind !== "not-applied") removeDesktopUpdateInstallRecord(filePath);
  return outcome;
}
