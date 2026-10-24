import * as Schema from "effect/Schema";
import { TrimmedString } from "./baseSchemas.ts";

export const MAX_KEYBINDING_VALUE_LENGTH = 64;
const MAX_KEYBINDING_WHEN_LENGTH = 256;
export const MAX_WHEN_EXPRESSION_DEPTH = 64;
export const MAX_SCRIPT_ID_LENGTH = 24;
export const MAX_KEYBINDINGS_COUNT = 256;

export const THREAD_JUMP_KEYBINDING_COMMANDS = [
  "thread.jump.1",
  "thread.jump.2",
  "thread.jump.3",
  "thread.jump.4",
  "thread.jump.5",
  "thread.jump.6",
  "thread.jump.7",
  "thread.jump.8",
  "thread.jump.9",
] as const;
export type ThreadJumpKeybindingCommand = (typeof THREAD_JUMP_KEYBINDING_COMMANDS)[number];

export const MODEL_PICKER_JUMP_KEYBINDING_COMMANDS = [
  "modelPicker.jump.1",
  "modelPicker.jump.2",
  "modelPicker.jump.3",
  "modelPicker.jump.4",
  "modelPicker.jump.5",
  "modelPicker.jump.6",
  "modelPicker.jump.7",
  "modelPicker.jump.8",
  "modelPicker.jump.9",
] as const;
export type ModelPickerJumpKeybindingCommand =
  (typeof MODEL_PICKER_JUMP_KEYBINDING_COMMANDS)[number];

export const THREAD_KEYBINDING_COMMANDS = [
  "thread.find",
  "thread.pinToggle",
  "thread.previous",
  "thread.next",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
] as const;
export type ThreadKeybindingCommand = (typeof THREAD_KEYBINDING_COMMANDS)[number];

export const MODEL_PICKER_KEYBINDING_COMMANDS = [
  "modelPicker.toggle",
  ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
] as const;
export type ModelPickerKeybindingCommand = (typeof MODEL_PICKER_KEYBINDING_COMMANDS)[number];

/*
 * Commands of features built in parallel, one group each, so their changes never touch the same
 * lines. Never give these commands a node default: their default keys go into the matching group
 * in client-runtime's appKeybindingDefaults.ts.
 */

// Quick open and find in files.
export const FILE_SEARCH_KEYBINDING_COMMANDS = [] as const;

// Settle, snooze, archive, mark unread and undo for threads.
export const THREAD_LIFECYCLE_KEYBINDING_COMMANDS = [
  "thread.settle",
  "thread.snooze",
  "thread.archive",
  "thread.markUnread",
  "thread.undo",
] as const;

// The next thread that needs attention.
export const THREAD_ATTENTION_KEYBINDING_COMMANDS = [] as const;

// Back and forward, and the thread commands that ship with them.
export const NAVIGATION_KEYBINDING_COMMANDS = [] as const;

// Close and reopen views and tabs.
export const VIEW_KEYBINDING_COMMANDS = [] as const;

/**
 * Every built-in command a key can be bound to. Some ship without a default
 * key, so this — not the default keymap — is the list a keybindings editor
 * offers.
 */
export const STATIC_KEYBINDING_COMMANDS = [
  "terminal.toggle",
  "terminal.split",
  "terminal.new",
  "terminal.close",
  "workspace.files",
  "workspace.review",
  "workspace.terminal",
  "workspace.simulator",
  "diff.toggle",
  "commandPalette.toggle",
  "sidebar.showInbox",
  "sidebar.showProjects",
  "chat.new",
  "chat.newLocal",
  // Start a chat in its own Ryco-managed folder instead of a project. Its default key is
  // client-only, because nodes send their defaults to clients that cannot decode a newer command.
  "chat.newWithoutProject",
  "composer.stash",
  "editor.openFavorite",
  "pane.split",
  "pane.close",
  "pane.focusNext",
  "pane.focusPrevious",
  // Open the pull requests and projects pages; no default keys (users bind them).
  "pullRequests.open",
  "projects.open",
  ...MODEL_PICKER_KEYBINDING_COMMANDS,
  ...THREAD_KEYBINDING_COMMANDS,
  ...FILE_SEARCH_KEYBINDING_COMMANDS,
  ...THREAD_LIFECYCLE_KEYBINDING_COMMANDS,
  ...THREAD_ATTENTION_KEYBINDING_COMMANDS,
  ...NAVIGATION_KEYBINDING_COMMANDS,
  ...VIEW_KEYBINDING_COMMANDS,
] as const;
export type StaticKeybindingCommand = (typeof STATIC_KEYBINDING_COMMANDS)[number];

export const SCRIPT_RUN_COMMAND_PATTERN = Schema.TemplateLiteral([
  Schema.Literal("script."),
  Schema.NonEmptyString.check(
    Schema.isMaxLength(MAX_SCRIPT_ID_LENGTH),
    Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
  ),
  Schema.Literal(".run"),
]);

/** Client-owned script commands include the environment and project identity. */
export const SCOPED_SCRIPT_RUN_COMMAND = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^projectScript\.[^/]+\/[^/]+\/[a-z0-9][a-z0-9-]{0,23}\.run$/),
);

export const KeybindingCommand = Schema.Union([
  Schema.Literals(STATIC_KEYBINDING_COMMANDS),
  SCRIPT_RUN_COMMAND_PATTERN,
  SCOPED_SCRIPT_RUN_COMMAND,
]);
export type KeybindingCommand = typeof KeybindingCommand.Type;

const KeybindingValue = TrimmedString.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_KEYBINDING_VALUE_LENGTH),
);

const KeybindingWhen = TrimmedString.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_KEYBINDING_WHEN_LENGTH),
);
export const KeybindingRule = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
});
export type KeybindingRule = typeof KeybindingRule.Type;

export const KeybindingsConfig = Schema.Array(KeybindingRule).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);
export type KeybindingsConfig = typeof KeybindingsConfig.Type;

export const KeybindingShortcut = Schema.Struct({
  key: KeybindingValue,
  metaKey: Schema.Boolean,
  ctrlKey: Schema.Boolean,
  shiftKey: Schema.Boolean,
  altKey: Schema.Boolean,
  modKey: Schema.Boolean,
});
export type KeybindingShortcut = typeof KeybindingShortcut.Type;

const KeybindingWhenNodeRef = Schema.suspend(
  (): Schema.Codec<KeybindingWhenNode> => KeybindingWhenNode,
);
export const KeybindingWhenNode = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("identifier"),
    name: Schema.NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("not"),
    node: KeybindingWhenNodeRef,
  }),
  Schema.Struct({
    type: Schema.Literal("and"),
    left: KeybindingWhenNodeRef,
    right: KeybindingWhenNodeRef,
  }),
  Schema.Struct({
    type: Schema.Literal("or"),
    left: KeybindingWhenNodeRef,
    right: KeybindingWhenNodeRef,
  }),
]);
export type KeybindingWhenNode =
  | { type: "identifier"; name: string }
  | { type: "not"; node: KeybindingWhenNode }
  | { type: "and"; left: KeybindingWhenNode; right: KeybindingWhenNode }
  | { type: "or"; left: KeybindingWhenNode; right: KeybindingWhenNode };

export const ResolvedKeybindingRule = Schema.Struct({
  command: KeybindingCommand,
  shortcut: KeybindingShortcut,
  whenAst: Schema.optional(KeybindingWhenNode),
});
export type ResolvedKeybindingRule = typeof ResolvedKeybindingRule.Type;

export const ResolvedKeybindingsConfig = Schema.Array(ResolvedKeybindingRule).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);
export type ResolvedKeybindingsConfig = typeof ResolvedKeybindingsConfig.Type;

export class KeybindingsConfigError extends Schema.TaggedError<KeybindingsConfigError>()(
  "KeybindingsConfigParseError",
  {
    configPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unable to parse keybindings config at ${this.configPath}: ${this.detail}`;
  }
}

/** Local preferences only. An empty rules array retains defaults; disabled commands do not. */
export const AppKeybindings = Schema.Struct({
  rules: KeybindingsConfig,
  disabledCommands: Schema.Array(KeybindingCommand).check(
    Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
  ),
});
export type AppKeybindings = typeof AppKeybindings.Type;
