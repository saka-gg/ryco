import {
  KeybindingsConfig,
  type AppKeybindings,
  type KeybindingRule,
} from "@ryco/contracts/keybindings";
import { compileResolvedKeybindingsConfig } from "@ryco/shared/keybindings";
import * as Schema from "effect/Schema";
import { APP_DEFAULT_KEYBINDINGS } from "./appKeybindingDefaults.ts";
import { validateAppKeybindings } from "./appKeybindings.ts";

// Only the keybindings editor uses these. They live apart from the store module so the app's
// startup bundle does not carry them.

/** Whole-command comparison retains alternate/contextual overrides while letting defaults evolve. */
function actualOverrides(
  rules: readonly KeybindingRule[],
  defaults: readonly KeybindingRule[],
): readonly KeybindingRule[] {
  const unchanged = new Set(
    rules
      .map((rule) => rule.command)
      .filter((command) => {
        const commandDefaults = defaults.filter((rule) => rule.command === command);
        if (commandDefaults.length === 0) return false;
        const custom = rules.filter((rule) => rule.command === command);
        return (
          JSON.stringify(compileResolvedKeybindingsConfig(custom)) ===
          JSON.stringify(compileResolvedKeybindingsConfig(commandDefaults))
        );
      }),
  );
  return rules.filter((rule) => !unchanged.has(rule.command));
}

/** Persist a complete editor snapshot, including commands the user deliberately unbound. */
export function appKeybindingsFromRules(
  rules: readonly KeybindingRule[],
  defaults: readonly KeybindingRule[] = APP_DEFAULT_KEYBINDINGS,
): AppKeybindings {
  const decoded = Schema.decodeUnknownSync(KeybindingsConfig)(rules);
  // Compilation drops invalid rules, so reject them before comparing against defaults.
  validateAppKeybindings({ rules: decoded, disabledCommands: [] });
  const commands = new Set(decoded.map((rule) => rule.command));
  return validateAppKeybindings({
    rules: actualOverrides(decoded, defaults),
    disabledCommands: [...new Set(defaults.map((rule) => rule.command))].filter(
      (command) => !commands.has(command),
    ),
  });
}

/** Explicit import keeps all locally configured/disabled commands, including their contexts. */
export function importAppKeybindings(
  current: AppKeybindings,
  incoming: readonly KeybindingRule[],
): AppKeybindings {
  const imported = validateAppKeybindings({ rules: incoming, disabledCommands: [] });
  const owned = new Set([
    ...current.rules.map((rule) => rule.command),
    ...current.disabledCommands,
  ]);
  return validateAppKeybindings({
    rules: [
      ...actualOverrides(imported.rules, APP_DEFAULT_KEYBINDINGS).filter(
        (rule) => !owned.has(rule.command),
      ),
      ...current.rules,
    ],
    disabledCommands: current.disabledCommands,
  });
}

/** Project-scoped script commands in different projects never participate in the same context. */
export function keybindingCommandScopesOverlap(left: string, right: string): boolean {
  const scope = (command: string) =>
    command.startsWith("projectScript.") ? command.slice(0, command.lastIndexOf("/")) : null;
  const l = scope(left);
  const r = scope(right);
  return l === null || r === null || l === r;
}
