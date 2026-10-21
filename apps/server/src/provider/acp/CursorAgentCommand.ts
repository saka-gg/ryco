/**
 * Which command runs the Cursor Agent CLI.
 *
 * Cursor installs its CLI as both `cursor-agent` and `agent`, and the settings default is the
 * bare `agent`. Other CLIs ship an `agent` executable too (the Grok CLI does), and whichever comes
 * first on PATH wins. When the configured command is that default and `cursor-agent` is on PATH,
 * Ryco spawns `cursor-agent`, the name only Cursor uses. Explicit binary paths are never
 * rewritten, and machines without `cursor-agent` keep spawning `agent` exactly as before.
 *
 * @module provider/acp/CursorAgentCommand
 */
import { ProviderDriverKind } from "@ryco/contracts";
import { resolveCommandPathAsync } from "@ryco/shared/shell";
import { Effect } from "effect";

import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  resolveHomebrewInstall,
  resolveHomebrewProviderMaintenance,
  resolveRealCommandPath,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import type { AcpStartupPhase } from "./AcpSessionRuntime.ts";

export const DEFAULT_CURSOR_AGENT_COMMAND = "agent";
export const PREFERRED_CURSOR_AGENT_COMMAND = "cursor-agent";

/** Next steps for Cursor ACP startup phases that stop answering (sessions, probes, text generation). */
export const cursorAcpPhaseTimeoutHints = (
  command: string,
): Partial<Record<AcpStartupPhase, string>> => ({
  initialize: `Check that \`${command}\` is the Cursor Agent CLI (\`${command} about\`) and that it is up to date.`,
  authenticate: `Cursor's login check did not answer; run \`${command} login\` and try again.`,
});

export interface ResolvedCursorAgentCommand {
  /** Command to spawn. */
  readonly command: string;
  /** Where `command` resolves on PATH, or `null` when it does not (spawn will then fail). */
  readonly resolvedPath: string | null;
}

// Session and text-generation spawns reuse the last resolution for the same PATH; provider
// probes re-resolve (`fresh`) so installing or removing `cursor-agent` is picked up.
const resolutionByPath = new Map<string, ResolvedCursorAgentCommand>();

/**
 * Resolves on the promise API with each PATH entry bounded, so a stalled network or File Provider
 * mount on PATH cannot block the event loop during probes and session spawns.
 */
export const resolveCursorAgentCommand = (
  binaryPath: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  options?: { readonly fresh?: boolean },
): Effect.Effect<ResolvedCursorAgentCommand> =>
  Effect.promise(async () => {
    const configured = binaryPath?.trim() || DEFAULT_CURSOR_AGENT_COMMAND;
    if (configured !== DEFAULT_CURSOR_AGENT_COMMAND) {
      return {
        command: configured,
        resolvedPath: await resolveCommandPathAsync(configured, { env: environment }),
      };
    }
    const pathKey = environment.PATH ?? environment.Path ?? "";
    const cached = options?.fresh === true ? undefined : resolutionByPath.get(pathKey);
    if (cached !== undefined) {
      return cached;
    }
    const preferredPath = await resolveCommandPathAsync(PREFERRED_CURSOR_AGENT_COMMAND, {
      env: environment,
    });
    const resolution: ResolvedCursorAgentCommand =
      preferredPath !== null
        ? { command: PREFERRED_CURSOR_AGENT_COMMAND, resolvedPath: preferredPath }
        : {
            command: DEFAULT_CURSOR_AGENT_COMMAND,
            resolvedPath: await resolveCommandPathAsync(DEFAULT_CURSOR_AGENT_COMMAND, {
              env: environment,
            }),
          };
    resolutionByPath.set(pathKey, resolution);
    return resolution;
  });

/** Commands a probe of `binaryPath` may spawn, for probe fingerprints. */
export const cursorAgentCommandCandidates = (
  binaryPath: string | null | undefined,
): ReadonlyArray<string> => {
  const configured = binaryPath?.trim() || DEFAULT_CURSOR_AGENT_COMMAND;
  return configured === DEFAULT_CURSOR_AGENT_COMMAND
    ? [PREFERRED_CURSOR_AGENT_COMMAND, DEFAULT_CURSOR_AGENT_COMMAND]
    : [configured];
};

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
