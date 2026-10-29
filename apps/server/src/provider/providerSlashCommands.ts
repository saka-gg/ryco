/**
 * providerSlashCommands - The slash commands an agent advertises itself (ACP
 * `available_commands_update`, OpenCode `command.list`), shaped for the composer menu.
 *
 * Agents send names with a leading `/`, duplicates, untrimmed or blank descriptions and lists
 * of any size. Contracts require trimmed, non-empty strings, so one bad entry would fail the
 * whole RPC or snapshot encode: every list goes through `normalizeProviderSlashCommands`.
 *
 * Driver-chunk only: import it from adapters and drivers, never from a module the serve path
 * loads eagerly (`serverBundleBoundaries.test.ts`).
 *
 * @module providerSlashCommands
 */
import type { ProviderProjectCommands, ServerProviderSlashCommand } from "@ryco/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

export const MAX_PROVIDER_SLASH_COMMANDS = 200;
/** Characters, the ellipsis included. Applies to argument hints too. */
export const MAX_SLASH_COMMAND_DESCRIPTION = 300;
/** A longer name is dropped, not cut: a cut name would run another command or none. */
export const MAX_SLASH_COMMAND_NAME = 128;
const DEFAULT_RECENT_PROJECT_DIRECTORIES = 16;

const SLASH_COMMAND_INPUT = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/u;
const UNSAFE_NAME_CHARACTER = /[\s/]/u;
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/u;

export interface ProviderSlashCommandEntry {
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly hint?: string | null | undefined;
}

export interface ProviderSlashCommandOptions {
  /** Lower-case names the menu must not offer. */
  readonly hidden?: ReadonlySet<string> | undefined;
}

function boundedText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_SLASH_COMMAND_DESCRIPTION) return trimmed;
  const cut = trimmed
    .slice(0, MAX_SLASH_COMMAND_DESCRIPTION - 1)
    .replace(TRAILING_HIGH_SURROGATE, "")
    .trimEnd();
  return `${cut}…`;
}

/**
 * Trims names and strips one leading `/`; drops empty or overlong names and names with whitespace or `/`;
 * keeps the first of names equal ignoring case; drops `hidden` names; omits blank descriptions
 * and hints; caps the count and the text length. Copies nothing else (no `_meta`, no OpenCode
 * template), so the result always encodes as `ServerProviderSlashCommand`.
 */
export function normalizeProviderSlashCommands(
  entries: Iterable<ProviderSlashCommandEntry>,
  options?: ProviderSlashCommandOptions,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  const commands: Array<ServerProviderSlashCommand> = [];
  for (const entry of entries) {
    if (commands.length >= MAX_PROVIDER_SLASH_COMMANDS) break;
    const trimmed = entry.name.trim();
    const name = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
    if (
      name.length === 0 ||
      name.length > MAX_SLASH_COMMAND_NAME ||
      UNSAFE_NAME_CHARACTER.test(name)
    )
      continue;
    const key = name.toLowerCase();
    if (seen.has(key) || options?.hidden?.has(key)) continue;
    seen.add(key);
    const description = boundedText(entry.description);
    const hint = boundedText(entry.hint);
    commands.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return commands;
}

export function acpAvailableCommandsToSlashCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  options?: ProviderSlashCommandOptions,
): ReadonlyArray<ServerProviderSlashCommand> {
  return normalizeProviderSlashCommands(
    commands.map((command) => ({
      name: command.name,
      description: command.description,
      hint: command.input?.hint,
    })),
    options,
  );
}

/**
 * `/name rest` as the command and its arguments; undefined for anything else. A path such as
 * `/Users/me/x.ts explain` is not a command.
 */
export function parseSlashCommandInput(
  input: string | undefined,
): { readonly name: string; readonly arguments: string } | undefined {
  const match = input?.trim().match(SLASH_COMMAND_INPUT);
  if (!match?.[1]) return undefined;
  return { name: match[1], arguments: match[2] ?? "" };
}

/**
 * The newest list an agent pushed per directory. Each push replaces its directory's entry, and
 * the entry outlives the session: an ACP agent lists commands only from inside a session, so
 * the next thread in that directory shows them before its own session starts. In memory only,
 * bounded to `capacity` directories; the least recently pushed one goes first.
 */
export function makeRecentProjectCommands(capacity = DEFAULT_RECENT_PROJECT_DIRECTORIES): {
  readonly record: (cwd: string, slashCommands: ReadonlyArray<ServerProviderSlashCommand>) => void;
  readonly read: (cwd: string) => ProviderProjectCommands | undefined;
} {
  const byDirectory = new Map<string, ProviderProjectCommands>();
  return {
    record: (cwd, slashCommands) => {
      byDirectory.delete(cwd);
      byDirectory.set(cwd, { skills: [], slashCommands });
      while (byDirectory.size > capacity) {
        const oldest = byDirectory.keys().next().value;
        if (oldest === undefined) break;
        byDirectory.delete(oldest);
      }
    },
    read: (cwd) => byDirectory.get(cwd),
  };
}
