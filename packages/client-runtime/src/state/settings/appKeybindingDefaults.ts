import type { KeybindingRule } from "@ryco/contracts/keybindings";
import {
  compileResolvedKeybindingsConfig,
  NODE_DEFAULT_KEYBINDINGS,
} from "@ryco/shared/keybindings";

/*
 * This app's default shortcuts. Nodes send the shared `NODE_DEFAULT_KEYBINDINGS` in
 * ServerConfig.keybindings to clients that decode its commands strictly, so a default for a
 * newer command must never go there: older apps could no longer read the node's config. New
 * defaults go into the client-only groups below, which no node writes or serves. Superseding a
 * node rule changes only this app's defaults; nodes keep serving their list unchanged.
 *
 * A new command takes four places: `STATIC_KEYBINDING_COMMANDS` in contracts, its default key in
 * its group here (if it has one), its title in the web app's keybinding categories, and its entry
 * in KEYBINDINGS.md. Never add it to the node list.
 */

/** Node default rules this app replaces, matched by key, command and `when`. */
export const SUPERSEDED_NODE_DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = [];

// Commands outside the feature groups below.
const CORE_CLIENT_DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = [
  { key: "mod+alt+n", command: "chat.newWithoutProject", when: "!terminalFocus" },
];

// Quick open and find in files.
const FILE_SEARCH_DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = [];

// Settle, snooze, archive, mark unread and undo for threads.
const THREAD_LIFECYCLE_DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = [];

// The next thread that needs attention.
const THREAD_ATTENTION_DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = [];

// Back and forward, and the thread commands that ship with them.
const NAVIGATION_DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = [];

// Close and reopen views and tabs.
const VIEW_DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = [];

export const CLIENT_ONLY_DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = [
  ...CORE_CLIENT_DEFAULT_KEYBINDINGS,
  ...FILE_SEARCH_DEFAULT_KEYBINDINGS,
  ...THREAD_LIFECYCLE_DEFAULT_KEYBINDINGS,
  ...THREAD_ATTENTION_DEFAULT_KEYBINDINGS,
  ...NAVIGATION_DEFAULT_KEYBINDINGS,
  ...VIEW_DEFAULT_KEYBINDINGS,
];

/** The node's rules minus the superseded ones, in node order, then the client-only rules. */
export function composeAppDefaultKeybindings(
  nodeDefaults: readonly KeybindingRule[],
  superseded: readonly KeybindingRule[],
  clientOnly: readonly KeybindingRule[],
): readonly KeybindingRule[] {
  const isSuperseded = (rule: KeybindingRule) =>
    superseded.some(
      (entry) =>
        entry.key === rule.key && entry.command === rule.command && entry.when === rule.when,
    );
  return [...nodeDefaults.filter((rule) => !isSuperseded(rule)), ...clientOnly];
}

export const APP_DEFAULT_KEYBINDINGS = composeAppDefaultKeybindings(
  NODE_DEFAULT_KEYBINDINGS,
  SUPERSEDED_NODE_DEFAULT_KEYBINDINGS,
  CLIENT_ONLY_DEFAULT_KEYBINDINGS,
);

export const APP_DEFAULT_RESOLVED_KEYBINDINGS =
  compileResolvedKeybindingsConfig(APP_DEFAULT_KEYBINDINGS);
