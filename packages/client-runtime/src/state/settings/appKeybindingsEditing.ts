import {
  KeybindingsConfig,
  type AppKeybindings,
  type KeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@ryco/contracts/keybindings";
import {
  compileResolvedKeybindingsConfig,
  NODE_DEFAULT_KEYBINDINGS,
} from "@ryco/shared/keybindings";
import * as Schema from "effect/Schema";
import {
  APP_DEFAULT_KEYBINDINGS,
  APP_DEFAULT_RESOLVED_KEYBINDINGS,
} from "./appKeybindingDefaults.ts";
import { resolveAppKeybindings, validateAppKeybindings } from "./appKeybindings.ts";

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

/**
 * Save an editor snapshot over `current`. A command whose shortcuts the snapshot leaves as they
 * are keeps its saved form, because another Ryco version sharing the document may read it
 * differently: a rule that matches a default only in this version, or an unbinding of a command
 * that has a default only in another one.
 */
export function appKeybindingsFromEditor(
  current: AppKeybindings,
  rules: readonly KeybindingRule[],
  defaults: readonly KeybindingRule[] = APP_DEFAULT_KEYBINDINGS,
): AppKeybindings {
  const next = appKeybindingsFromRules(rules, defaults);
  const resolvedDefaults =
    defaults === APP_DEFAULT_KEYBINDINGS
      ? APP_DEFAULT_RESOLVED_KEYBINDINGS
      : compileResolvedKeybindingsConfig(defaults);
  const before = resolveAppKeybindings(current, resolvedDefaults);
  const after = resolveAppKeybindings(next, resolvedDefaults);
  const shortcutsOf = (resolved: ResolvedKeybindingsConfig, command: string) =>
    JSON.stringify(resolved.filter((rule) => rule.command === command));
  const unchangedByCommand = new Map<string, boolean>();
  const unchanged = (command: string) => {
    let result = unchangedByCommand.get(command);
    if (result === undefined) {
      result = shortcutsOf(before, command) === shortcutsOf(after, command);
      unchangedByCommand.set(command, result);
    }
    return result;
  };
  return validateAppKeybindings({
    rules: [
      ...current.rules.filter((rule) => unchanged(rule.command)),
      ...next.rules.filter((rule) => !unchanged(rule.command)),
    ],
    disabledCommands: [
      ...current.disabledCommands.filter(unchanged),
      ...next.disabledCommands.filter((command) => !unchanged(command)),
    ],
  });
}

/** Explicit import keeps all locally configured/disabled commands, including their contexts. */
export function importAppKeybindings(
  current: AppKeybindings,
  incoming: readonly KeybindingRule[],
  defaults: readonly KeybindingRule[] = APP_DEFAULT_KEYBINDINGS,
): AppKeybindings {
  const imported = validateAppKeybindings({ rules: incoming, disabledCommands: [] });
  const owned = new Set([
    ...current.rules.map((rule) => rule.command),
    ...current.disabledCommands,
  ]);
  // Older nodes wrote their whole default list into the file, so a command matching the node's
  // defaults is untouched too, even where this app replaced that default.
  const overrides = actualOverrides(
    actualOverrides(imported.rules, defaults),
    NODE_DEFAULT_KEYBINDINGS,
  );
  return validateAppKeybindings({
    rules: [...overrides.filter((rule) => !owned.has(rule.command)), ...current.rules],
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
