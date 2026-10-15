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
import { resolveCommandPath } from "@ryco/shared/shell";
import { Effect } from "effect";

import {
  makeProviderMaintenanceCapabilities,
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

export const resolveCursorAgentCommand = (
  binaryPath: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  options?: { readonly fresh?: boolean },
): Effect.Effect<ResolvedCursorAgentCommand> =>
  Effect.sync(() => {
    const configured = binaryPath?.trim() || DEFAULT_CURSOR_AGENT_COMMAND;
    if (configured !== DEFAULT_CURSOR_AGENT_COMMAND) {
      return {
        command: configured,
        resolvedPath: resolveCommandPath(configured, { env: environment }),
      };
    }
    const pathKey = environment.PATH ?? environment.Path ?? "";
    const cached = options?.fresh === true ? undefined : resolutionByPath.get(pathKey);
    if (cached !== undefined) {
      return cached;
    }
    const preferredPath = resolveCommandPath(PREFERRED_CURSOR_AGENT_COMMAND, { env: environment });
    const resolution: ResolvedCursorAgentCommand =
      preferredPath !== null
        ? { command: PREFERRED_CURSOR_AGENT_COMMAND, resolvedPath: preferredPath }
        : {
            command: DEFAULT_CURSOR_AGENT_COMMAND,
            resolvedPath: resolveCommandPath(DEFAULT_CURSOR_AGENT_COMMAND, { env: environment }),
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

/**
 * Cursor updates itself (`<command> update`). The update runs the resolved command, so it never
 * reaches another CLI's `agent` that happens to come first on PATH.
 */
export const makeCursorMaintenanceCapabilities = (
  command: ResolvedCursorAgentCommand,
): ProviderMaintenanceCapabilities =>
  makeProviderMaintenanceCapabilities({
    provider: ProviderDriverKind.make("cursor"),
    packageName: null,
    updateExecutable: command.resolvedPath ?? command.command,
    updateArgs: ["update"],
    updateLockKey: "cursor-agent",
  });
