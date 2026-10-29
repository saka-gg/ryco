/**
 * How Cursor's CLI updates itself, for the command `CursorAgentCommand.ts` resolved.
 *
 * @module provider/acp/CursorAgentMaintenance
 */
import { ProviderDriverKind } from "@ryco/contracts";
import { Effect } from "effect";

import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  resolveHomebrewInstall,
  resolveHomebrewProviderMaintenance,
  resolveRealCommandPath,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import type { ResolvedCursorAgentCommand } from "./CursorAgentCommand.ts";

const CURSOR_DRIVER_KIND = ProviderDriverKind.make("cursor");
const CURSOR_HOMEBREW_CASK = "cursor-cli";

/**
 * Cursor updates itself (`<command> update`). The update runs the resolved command, so it never
 * reaches another CLI's `agent` that happens to come first on PATH.
 */
export const makeCursorMaintenanceCapabilities = (
  command: ResolvedCursorAgentCommand,
): ProviderMaintenanceCapabilities =>
  makeProviderMaintenanceCapabilities({
    provider: CURSOR_DRIVER_KIND,
    packageName: null,
    updateExecutable: command.resolvedPath ?? command.command,
    updateArgs: ["update"],
    updateLockKey: "cursor-agent",
  });

/**
 * {@link makeCursorMaintenanceCapabilities}, except for the `cursor-cli` Homebrew cask, which
 * Homebrew owns: it upgrades with `brew upgrade --cask cursor-cli` once a `brew` confirms the
 * keg's prefix, and stays manual otherwise. The advisory's latest version stays unknown either
 * way, as for every Cursor install: Cursor's date-stamped versions are not compared.
 */
export const resolveCursorMaintenanceCapabilities = Effect.fn(
  "resolveCursorMaintenanceCapabilities",
)(function* (command: ResolvedCursorAgentCommand, environment: NodeJS.ProcessEnv = process.env) {
  const native = makeCursorMaintenanceCapabilities(command);
  if (command.resolvedPath === null) {
    return native;
  }
  const realPath = yield* resolveRealCommandPath(command.resolvedPath);
  const install = realPath ? yield* resolveHomebrewInstall(realPath) : null;
  if (install?.kind !== "cask" || install.name.toLowerCase() !== CURSOR_HOMEBREW_CASK) {
    return native;
  }
  return (
    (yield* resolveHomebrewProviderMaintenance({
      provider: CURSOR_DRIVER_KIND,
      packageName: null,
      install,
      env: environment,
      platform: process.platform,
      lookupLatestVersion: false,
    })) ??
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: CURSOR_DRIVER_KIND,
      packageName: null,
      ...(realPath ? { installPath: realPath } : {}),
      latestVersion: null,
    })
  );
});
