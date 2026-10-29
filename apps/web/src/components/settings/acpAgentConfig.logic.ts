import type { AcpAgentSource } from "@ryco/contracts";

/** An ACP Registry instance's config as the settings UI reads it; the server decodes the real one. */
export interface AcpAgentConfig {
  readonly source: AcpAgentSource;
  readonly agentId: string;
  readonly version: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** The part of the config a local command editor owns. */
export interface AcpLocalCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const EMPTY_ARGS: ReadonlyArray<string> = [];
const MAX_COMMAND_LENGTH = 4096;
const REGISTRY_KEYS = ["agentId", "version"] as const;
const LOCAL_COMMAND_KEYS = ["source", "command", "args"] as const;

function readString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

export function readAcpAgentConfig(value: unknown): AcpAgentConfig {
  const config = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const args = config.args;
  return {
    source: config.source === "local" ? "local" : "registry",
    agentId: readString(config, "agentId"),
    version: readString(config, "version"),
    command: readString(config, "command"),
    args: Array.isArray(args)
      ? args.filter((argument): argument is string => typeof argument === "string")
      : EMPTY_ARGS,
  };
}

/** Whether an instance with this config can be added: a pinned install, or a usable command. */
export function isAcpAgentConfigComplete(value: unknown): boolean {
  const config = readAcpAgentConfig(value);
  return config.source === "local"
    ? config.command.trim().length > 0 && acpLocalCommandError(config.command) === null
    : config.agentId.length > 0 && config.version.length > 0;
}

/**
 * A hint for an executable the node will refuse. The node resolves the command itself and has the
 * final say; this cannot know its platform or PATH, so it only flags relative paths and bad input.
 */
export function acpLocalCommandError(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.includes("\0")) return "The executable cannot contain NUL characters.";
  if (trimmed.length > MAX_COMMAND_LENGTH) return "The executable path is too long.";
  const isPath = trimmed.includes("/") || trimmed.includes("\\");
  // POSIX absolute, `~/…`, a Windows drive (`C:\…`), or a UNC share (`\\server\…`).
  const isAbsolute = /^(?:\/|~(?:[\\/]|$)|[A-Za-z]:[\\/]|\\\\)/u.test(trimmed);
  return isPath && !isAbsolute ? "Use an absolute path or a command name on PATH." : null;
}

/** The config's keys apart from `owned`: other settings, such as `customModels`, share the blob. */
function otherKeys(current: unknown, owned: ReadonlyArray<string>): Record<string, unknown> {
  if (!current || typeof current !== "object") return {};
  const rest: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const key of owned) delete rest[key];
  return rest;
}

/**
 * The config after a local command edit. Registry fields are dropped, since the instance no longer
 * uses an install; every other key is kept.
 */
export function localCommandConfig(
  current: unknown,
  next: AcpLocalCommand,
): Record<string, unknown> {
  return {
    ...otherKeys(current, REGISTRY_KEYS),
    source: "local",
    command: next.command.trim(),
    args: [...next.args],
  };
}

/** The config after a registry install is chosen. Local command fields are dropped; others kept. */
export function registryAgentConfig(
  current: unknown,
  installation: { readonly agentId: string; readonly version: string },
): Record<string, unknown> {
  return {
    ...otherKeys(current, LOCAL_COMMAND_KEYS),
    agentId: installation.agentId,
    version: installation.version,
  };
}

export function sameArguments(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((argument, index) => argument === right[index]);
}

export function sameLocalCommand(left: AcpLocalCommand, right: AcpLocalCommand): boolean {
  return left.command === right.command && sameArguments(left.args, right.args);
}

/**
 * Matches the command a node reports against the edits still waiting for it. A match is the echo
 * of that edit: it returns the edits published after it, since echoes arrive in publish order. The
 * oldest match wins, so publishing the same command twice waits for both echoes. `null` means the
 * report is none of them, so the config changed somewhere else.
 */
export function settlePublishedCommands(
  pending: ReadonlyArray<AcpLocalCommand>,
  reported: AcpLocalCommand,
): ReadonlyArray<AcpLocalCommand> | null {
  const index = pending.findIndex((published) => sameLocalCommand(published, reported));
  return index === -1 ? null : pending.slice(index + 1);
}
