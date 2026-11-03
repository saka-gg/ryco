/**
 * openCodeCommands - OpenCode's `command.list` shaped for the composer's `/` menu.
 *
 * OpenCode lists its built-in commands, the user's and a project's own, MCP prompts and skills
 * in one list per directory. Skills stay out: the menu's skills carry the file path that
 * `command.list` does not report. Only the name, description and argument hints are kept; the
 * template, agent and model never leave the server.
 *
 * Driver-chunk only, like `providerSlashCommands`: never import it from a module the serve path
 * loads eagerly (`serverBundleBoundaries.test.ts`).
 *
 * @module openCodeCommands
 */
import type { Command } from "@opencode-ai/sdk/v2";
import type { ServerProviderSlashCommand } from "@ryco/contracts";

import { normalizeProviderSlashCommands } from "./providerSlashCommands.ts";

export function openCodeCommandsToSlashCommands(
  commands: ReadonlyArray<Pick<Command, "name" | "description" | "source" | "hints">>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return normalizeProviderSlashCommands(
    commands
      .filter((command) => command.source !== "skill")
      .map((command) => ({
        name: command.name,
        description: command.description,
        // The placeholders the template substitutes (`$ARGUMENTS`, `$1`); older servers omit them.
        hint: Array.isArray(command.hints) ? command.hints.join(" ") : undefined,
      })),
  );
}
