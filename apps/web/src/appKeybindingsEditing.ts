import type { KeybindingRule } from "@ryco/contracts";
import { appKeybindingsFromRules, importAppKeybindings } from "@ryco/client-runtime/state/settings";
import { updateAppKeybindingsPreferences } from "./appKeybindings";

// Keybindings editor actions, kept out of appKeybindings.ts so they load with the editor rather
// than at startup.

export function replaceAppKeybindings(rules: readonly KeybindingRule[]): Promise<void> {
  const next = appKeybindingsFromRules(rules);
  return updateAppKeybindingsPreferences(() => next);
}

export function importLegacyKeybindings(rules: readonly KeybindingRule[]): Promise<void> {
  return updateAppKeybindingsPreferences((current) => importAppKeybindings(current, rules));
}
