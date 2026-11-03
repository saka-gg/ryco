import {
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  STATIC_KEYBINDING_COMMANDS,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type StaticKeybindingCommand,
} from "@ryco/contracts";
import { APP_DEFAULT_KEYBINDINGS } from "@ryco/client-runtime/state/settings";

import { getCommandMeta, keybindingRowId } from "../../lib/keybindingCategories";
import type { SettingsSearchEntry } from "./settingsSearchIndex";

// Each numbered set is one result, at the row of its first command.
const NUMBERED_COMMAND_SETS: ReadonlyArray<{
  readonly commands: ReadonlyArray<StaticKeybindingCommand>;
  readonly title: string;
}> = [
  { commands: THREAD_JUMP_KEYBINDING_COMMANDS, title: "Jump to thread 1–9" },
  { commands: MODEL_PICKER_JUMP_KEYBINDING_COMMANDS, title: "Pick model 1–9" },
];

// Default keys are saved as "mod+…"; people search for the key they press.
function keySearchTerms(key: string): ReadonlyArray<string> {
  return key.startsWith("mod+")
    ? [key, key.replace("mod+", "cmd+"), key.replace("mod+", "ctrl+")]
    : [key];
}

function keybindingSearchEntry(
  commands: ReadonlyArray<StaticKeybindingCommand>,
  title: string,
): SettingsSearchEntry {
  const command = commands[0]!;
  const keys = APP_DEFAULT_KEYBINDINGS.filter((rule) =>
    (commands as ReadonlyArray<KeybindingCommand>).includes(rule.command),
  ).flatMap((rule) => keySearchTerms(rule.key));
  return {
    section: "keybindings",
    owner: "client",
    title,
    description: `${getCommandMeta(command).category.label} shortcut`,
    keywords: [...new Set([...commands, ...keys])].join(" "),
    targetId: keybindingRowId(command),
  };
}

/**
 * One search result per built-in command, by its title, its id or its default key. Kept out of
 * `SETTINGS_SEARCH_INDEX`, so only the settings search lists them, after the settings themselves.
 */
export const KEYBINDING_SEARCH_ENTRIES: ReadonlyArray<SettingsSearchEntry> =
  STATIC_KEYBINDING_COMMANDS.flatMap((command) => {
    const numbered = NUMBERED_COMMAND_SETS.find((set) => set.commands.includes(command));
    if (!numbered) return [keybindingSearchEntry([command], getCommandMeta(command).title)];
    return numbered.commands[0] === command
      ? [keybindingSearchEntry(numbered.commands, numbered.title)]
      : [];
  });
