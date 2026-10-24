import type { KeybindingCommand, StaticKeybindingCommand } from "@ryco/contracts";

export interface KeybindingCategory {
  readonly id: string;
  readonly label: string;
  readonly sortWeight: number;
}

/** Keyed by command prefix (`thread.next` → Threads). Categories without commands are not shown. */
export const KEYBINDING_CATEGORIES = {
  terminal: { id: "terminal", label: "Terminal", sortWeight: 10 },
  workspace: { id: "workspace", label: "Workspace", sortWeight: 20 },
  diff: { id: "diff", label: "Diff", sortWeight: 30 },
  commandPalette: { id: "commandPalette", label: "Command palette", sortWeight: 40 },
  sidebar: { id: "sidebar", label: "Sidebar", sortWeight: 50 },
  navigation: { id: "navigation", label: "Navigation", sortWeight: 55 },
  chat: { id: "chat", label: "Chat", sortWeight: 60 },
  composer: { id: "composer", label: "Composer", sortWeight: 70 },
  editor: { id: "editor", label: "Editor", sortWeight: 80 },
  modelPicker: { id: "modelPicker", label: "Model picker", sortWeight: 90 },
  thread: { id: "thread", label: "Threads", sortWeight: 100 },
  view: { id: "view", label: "Tabs and panes", sortWeight: 104 },
  pane: { id: "pane", label: "Split view", sortWeight: 105 },
  pullRequests: { id: "pullRequests", label: "Pull requests", sortWeight: 107 },
  projects: { id: "projects", label: "Projects", sortWeight: 108 },
  script: { id: "script", label: "Project scripts", sortWeight: 110 },
} as const satisfies Record<string, KeybindingCategory>;

export interface KeybindingCommandMeta {
  readonly category: KeybindingCategory;
  readonly title: string;
  readonly sortWeight: number;
}

type StaticCommandMeta = Omit<KeybindingCommandMeta, "category">;
type StaticCommandMetaGroup = Partial<Record<StaticKeybindingCommand, StaticCommandMeta>>;

// Commands outside the feature groups below.
const CORE_COMMAND_META = {
  "terminal.toggle": { title: "Toggle terminal drawer", sortWeight: 1 },
  "terminal.split": { title: "Split terminal", sortWeight: 2 },
  "terminal.new": { title: "New terminal", sortWeight: 3 },
  "terminal.close": { title: "Close terminal", sortWeight: 4 },
  "workspace.files": { title: "Open workspace files", sortWeight: 1 },
  "workspace.review": { title: "Open workspace review", sortWeight: 2 },
  "workspace.terminal": { title: "Open workspace terminal", sortWeight: 3 },
  "workspace.simulator": { title: "Open iOS Simulator workspace", sortWeight: 4 },
  "diff.toggle": { title: "Toggle diff view", sortWeight: 1 },
  "commandPalette.toggle": { title: "Open command palette", sortWeight: 1 },
  "sidebar.showInbox": { title: "Show Inbox sidebar", sortWeight: 1 },
  "sidebar.showProjects": { title: "Show Projects sidebar", sortWeight: 2 },
  "chat.new": { title: "New chat", sortWeight: 1 },
  "chat.newLocal": { title: "New chat (local environment)", sortWeight: 2 },
  "chat.newWithoutProject": { title: "New chat without a project", sortWeight: 3 },
  "composer.stash": { title: "Stash prompt or open stash", sortWeight: 1 },
  "editor.openFavorite": { title: "Open in preferred editor", sortWeight: 1 },
  "modelPicker.toggle": { title: "Toggle model picker", sortWeight: 1 },
  "modelPicker.jump.1": { title: "Pick model 1", sortWeight: 2 },
  "modelPicker.jump.2": { title: "Pick model 2", sortWeight: 3 },
  "modelPicker.jump.3": { title: "Pick model 3", sortWeight: 4 },
  "modelPicker.jump.4": { title: "Pick model 4", sortWeight: 5 },
  "modelPicker.jump.5": { title: "Pick model 5", sortWeight: 6 },
  "modelPicker.jump.6": { title: "Pick model 6", sortWeight: 7 },
  "modelPicker.jump.7": { title: "Pick model 7", sortWeight: 8 },
  "modelPicker.jump.8": { title: "Pick model 8", sortWeight: 9 },
  "modelPicker.jump.9": { title: "Pick model 9", sortWeight: 10 },
  "thread.find": { title: "Find in current thread", sortWeight: 1 },
  "thread.pinToggle": { title: "Pin or unpin current thread", sortWeight: 2 },
  "thread.previous": { title: "Previous thread", sortWeight: 3 },
  "thread.next": { title: "Next thread", sortWeight: 4 },
  "thread.jump.1": { title: "Jump to thread 1", sortWeight: 5 },
  "thread.jump.2": { title: "Jump to thread 2", sortWeight: 6 },
  "thread.jump.3": { title: "Jump to thread 3", sortWeight: 7 },
  "thread.jump.4": { title: "Jump to thread 4", sortWeight: 8 },
  "thread.jump.5": { title: "Jump to thread 5", sortWeight: 9 },
  "thread.jump.6": { title: "Jump to thread 6", sortWeight: 10 },
  "thread.jump.7": { title: "Jump to thread 7", sortWeight: 11 },
  "thread.jump.8": { title: "Jump to thread 8", sortWeight: 12 },
  "thread.jump.9": { title: "Jump to thread 9", sortWeight: 13 },
  "pane.split": { title: "Open a thread in split view", sortWeight: 1 },
  "pane.close": { title: "Close focused pane", sortWeight: 2 },
  "pane.focusNext": { title: "Focus next pane", sortWeight: 3 },
  "pane.focusPrevious": { title: "Focus previous pane", sortWeight: 4 },
  "pullRequests.open": { title: "Open pull requests", sortWeight: 1 },
  // Not "Show Projects": that is the sidebar mode (`sidebar.showProjects`).
  "projects.open": { title: "Open projects page", sortWeight: 1 },
} satisfies StaticCommandMetaGroup;

// Quick open and find in files.
const FILE_SEARCH_COMMAND_META = {} satisfies StaticCommandMetaGroup;

// Settle, snooze, archive, mark unread and undo for threads (Threads, sort weights from 20).
const THREAD_LIFECYCLE_COMMAND_META = {
  "thread.settle": { title: "Settle current thread or move it to Active", sortWeight: 20 },
  "thread.snooze": { title: "Snooze or unsnooze current thread", sortWeight: 21 },
  "thread.archive": { title: "Archive current thread", sortWeight: 22 },
  "thread.markUnread": { title: "Mark current thread unread", sortWeight: 23 },
  "thread.undo": { title: "Undo last thread action", sortWeight: 24 },
} satisfies StaticCommandMetaGroup;

// The next thread that needs attention (Threads, sort weights from 30).
const THREAD_ATTENTION_COMMAND_META = {
  "thread.attention.next": { title: "Next thread that needs you", sortWeight: 30 },
  "thread.attention.previous": { title: "Previous thread that needs you", sortWeight: 31 },
} satisfies StaticCommandMetaGroup;

// Back and forward (Navigation), and the thread commands that ship with them (Threads, sort
// weights from 40).
const NAVIGATION_COMMAND_META = {
  "navigation.back": { title: "Go back", sortWeight: 1 },
  "navigation.forward": { title: "Go forward", sortWeight: 2 },
  "thread.interrupt": { title: "Interrupt turn", sortWeight: 40 },
  "thread.copyReference": { title: "Copy pull request link or thread ID", sortWeight: 41 },
} satisfies StaticCommandMetaGroup;

// Close and reopen views and tabs.
const VIEW_COMMAND_META = {
  "view.close": { title: "Close tab or pane", sortWeight: 1 },
  "view.reopenClosed": { title: "Reopen closed tab or pane", sortWeight: 2 },
} satisfies StaticCommandMetaGroup;

// Typed over every static command, so a command without a title fails typecheck.
const STATIC_COMMAND_META: Readonly<Record<StaticKeybindingCommand, StaticCommandMeta>> = {
  ...CORE_COMMAND_META,
  ...FILE_SEARCH_COMMAND_META,
  ...THREAD_LIFECYCLE_COMMAND_META,
  ...THREAD_ATTENTION_COMMAND_META,
  ...NAVIGATION_COMMAND_META,
  ...VIEW_COMMAND_META,
};

function isStaticCommand(command: KeybindingCommand): command is StaticKeybindingCommand {
  return Object.hasOwn(STATIC_COMMAND_META, command);
}

function categoryForCommand(command: KeybindingCommand): KeybindingCategory {
  const dotIndex = command.indexOf(".");
  const root = dotIndex === -1 ? command : command.slice(0, dotIndex);
  // `projectScript.*` joins `script.*` under Project scripts. Every static command has a category.
  return Object.hasOwn(KEYBINDING_CATEGORIES, root)
    ? KEYBINDING_CATEGORIES[root as keyof typeof KEYBINDING_CATEGORIES]
    : KEYBINDING_CATEGORIES.script;
}

/** The id of a command's row in the Keybindings panel, which settings search results reveal. */
export function keybindingRowId(command: KeybindingCommand): string {
  return `keybinding-${command}`;
}

export function getCommandMeta(
  command: KeybindingCommand,
  scriptTitle?: string,
): KeybindingCommandMeta {
  const category = categoryForCommand(command);
  if (isStaticCommand(command)) {
    const staticMeta = STATIC_COMMAND_META[command];
    return { category, title: staticMeta.title, sortWeight: staticMeta.sortWeight };
  }
  // script.<id>.run — derive title from the id if no friendly title was provided.
  const match = command.match(/^script\.([a-z0-9][a-z0-9-]*)\.run$/);
  const scriptId = match?.[1] ?? command;
  return {
    category,
    title: scriptTitle ?? `Run: ${scriptId}`,
    sortWeight: 100,
  };
}
