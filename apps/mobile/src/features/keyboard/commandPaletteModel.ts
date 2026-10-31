import {
  buildCommandPaletteRootGroups,
  buildCommandPaletteRows,
  COMMAND_PALETTE_RECENT_THREAD_LIMIT,
  filterCommandPaletteGroups,
  type CommandPaletteRow,
  type CommandPaletteRows,
  type CommandPaletteSearchGroup,
  type CommandPaletteTypedSearchGroup,
} from "@ryco/client-runtime/commandPalette/search";
import {
  isUnarchivedThreadEntry,
  sortThreads,
  type Project,
  type SidebarThreadOrStub,
  type SidebarThreadSummary,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { excludeChatProjects } from "@ryco/shared/projectKind";

import type { AppSymbolName } from "../../components/AppSymbol";
import type { MVP_SETTINGS_SHEET_ROUTES } from "../../navigation/mvpRouteConfig";
import { threadJumpIndex, type HardwareKeyboardCommand } from "./hardwareKeyboardCommands";

/** A thread screen's own tools, offered while the open thread has them. */
export type CommandPaletteThreadCommand = Extract<
  HardwareKeyboardCommand,
  "files" | "terminal" | "review"
>;

/** The settings screens the palette opens directly; none of them takes params. */
export type CommandPaletteSettingsScreen = Extract<
  keyof typeof MVP_SETTINGS_SHEET_ROUTES,
  | "Settings"
  | "SettingsAppearance"
  | "SettingsWorkspace"
  | "SettingsProviderAccounts"
  | "SettingsInbox"
  | "SettingsStatistics"
>;

/** What choosing an item does; the palette screen maps each to navigation. */
export type CommandPaletteIntent =
  | {
      readonly type: "newTask";
      readonly environmentId?: EnvironmentId;
      readonly projectId?: ProjectId;
    }
  | { readonly type: "addProject" }
  | { readonly type: "machines" }
  | { readonly type: "settings"; readonly screen: CommandPaletteSettingsScreen }
  | { readonly type: "command"; readonly command: CommandPaletteThreadCommand }
  | {
      readonly type: "project";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
    }
  | {
      readonly type: "thread";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    };

export interface CommandPaletteItem {
  readonly value: string;
  readonly kind: "action" | "project" | "thread";
  readonly title: string;
  readonly detail?: string;
  readonly icon: AppSymbolName;
  readonly searchTerms: ReadonlyArray<string>;
  readonly idSearchTerms?: ReadonlyArray<string>;
  readonly intent: CommandPaletteIntent;
}

export interface CommandPaletteSources {
  readonly activeGroups: ReadonlyArray<CommandPaletteSearchGroup<CommandPaletteItem>>;
  readonly searchGroups: ReadonlyArray<CommandPaletteTypedSearchGroup<CommandPaletteItem>>;
}

const SETTINGS_ACTIONS: ReadonlyArray<{
  readonly screen: CommandPaletteSettingsScreen;
  readonly title: string;
  readonly icon: AppSymbolName;
  readonly searchTerms: ReadonlyArray<string>;
}> = [
  {
    screen: "Settings",
    title: "Open settings",
    icon: "gearshape",
    searchTerms: ["preferences", "configuration"],
  },
  {
    screen: "SettingsAppearance",
    title: "Appearance",
    icon: "paintbrush",
    searchTerms: ["theme", "dark", "light", "text size"],
  },
  {
    screen: "SettingsWorkspace",
    title: "Workspace defaults",
    icon: "slider.horizontal.3",
    searchTerms: ["model", "access", "defaults"],
  },
  {
    screen: "SettingsProviderAccounts",
    title: "Provider accounts",
    icon: "person.crop.circle",
    searchTerms: ["sign in", "codex", "claude", "accounts"],
  },
  {
    screen: "SettingsInbox",
    title: "Inbox settings",
    icon: "tray",
    searchTerms: ["settle", "snooze", "inbox"],
  },
  {
    screen: "SettingsStatistics",
    title: "Statistics",
    icon: "chart.bar.xaxis",
    searchTerms: ["usage", "limits", "cost"],
  },
];

const THREAD_COMMAND_ACTIONS: ReadonlyArray<{
  readonly command: CommandPaletteThreadCommand;
  readonly title: string;
  readonly icon: AppSymbolName;
  readonly searchTerms: ReadonlyArray<string>;
}> = [
  {
    command: "files",
    title: "Open files",
    icon: "folder",
    searchTerms: ["browse", "workspace", "files"],
  },
  {
    command: "terminal",
    title: "Open terminal",
    icon: "terminal",
    searchTerms: ["shell", "console"],
  },
  {
    command: "review",
    title: "Review changes",
    icon: "arrow.triangle.pull",
    searchTerms: ["diff", "git", "changes"],
  },
];

function threadItem(input: {
  readonly thread: SidebarThreadSummary;
  readonly projectTitle: string | undefined;
  readonly machineLabel: string | undefined;
  readonly current: boolean;
}): CommandPaletteItem {
  const { thread } = input;
  const detail = [
    input.projectTitle,
    thread.branch ? `#${thread.branch}` : undefined,
    input.machineLabel,
    input.current ? "Current thread" : undefined,
  ]
    .filter((part) => part !== undefined && part.length > 0)
    .join(" · ");
  return {
    value: `thread:${thread.environmentId}:${thread.id}`,
    kind: "thread",
    title: thread.title || "Untitled task",
    ...(detail ? { detail } : {}),
    icon: "text.bubble",
    // The same fields, in the same priority, as the web palette's thread items.
    searchTerms: [thread.title, input.projectTitle ?? "", thread.branch ?? ""],
    idSearchTerms: [thread.id],
    intent: { type: "thread", environmentId: thread.environmentId, threadId: thread.id },
  };
}

/**
 * Everything the palette can show, before a query narrows it: actions and
 * recent threads for the empty palette, and every project and thread to search.
 *
 * Threads come in the order the web palette lists them (latest activity first)
 * and leave out archived ones; projects leave out the "No project" chats, which
 * are not somewhere to open. The machine shows beside a thread only when more
 * than one machine is listed.
 */
export function buildCommandPaletteSources(input: {
  readonly projects: ReadonlyArray<Project>;
  readonly threads: ReadonlyArray<SidebarThreadOrStub>;
  readonly machineLabels: ReadonlyMap<string, string>;
  /** The thread the workspace shows, if any. */
  readonly activeThread: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  } | null;
  /** The open thread's tools that apply now (from the enabled key commands). */
  readonly threadCommands: ReadonlyArray<CommandPaletteThreadCommand>;
}): CommandPaletteSources {
  const projectKey = (environmentId: string, projectId: string) => `${environmentId}:${projectId}`;
  const projectsByKey = new Map(
    input.projects.map((project) => [projectKey(project.environmentId, project.id), project]),
  );
  const showMachine = input.machineLabels.size > 1;
  const threads = sortThreads(input.threads.filter(isUnarchivedThreadEntry), "updated_at");
  const activeThread = input.activeThread
    ? threads.find(
        (thread) =>
          thread.environmentId === input.activeThread?.environmentId &&
          thread.id === input.activeThread.threadId,
      )
    : undefined;
  const activeProject = activeThread
    ? projectsByKey.get(projectKey(activeThread.environmentId, activeThread.projectId))
    : undefined;

  const actions: CommandPaletteItem[] = [];
  if (activeProject) {
    actions.push({
      value: "action:new-task-in-project",
      kind: "action",
      title: `New task in ${activeProject.name}`,
      icon: "square.and.pencil",
      searchTerms: [`New task in ${activeProject.name}`, "create", "chat"],
      intent: {
        type: "newTask",
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
    });
  }
  actions.push(
    {
      value: "action:new-task",
      kind: "action",
      title: "New task",
      icon: "square.and.pencil",
      searchTerms: ["New task", "create", "chat", "thread"],
      intent: { type: "newTask" },
    },
    {
      value: "action:add-project",
      kind: "action",
      title: "Add project",
      icon: "folder.badge.plus",
      searchTerms: ["Add project", "folder", "repository", "clone"],
      intent: { type: "addProject" },
    },
    {
      value: "action:machines",
      kind: "action",
      title: "Machines",
      icon: "desktopcomputer",
      searchTerms: ["Machines", "connections", "pair", "node", "hub"],
      intent: { type: "machines" },
    },
  );
  for (const action of THREAD_COMMAND_ACTIONS) {
    if (!input.threadCommands.includes(action.command)) continue;
    actions.push({
      value: `action:${action.command}`,
      kind: "action",
      title: action.title,
      icon: action.icon,
      searchTerms: [action.title, ...action.searchTerms],
      intent: { type: "command", command: action.command },
    });
  }
  for (const action of SETTINGS_ACTIONS) {
    actions.push({
      value: `action:settings:${action.screen}`,
      kind: "action",
      title: action.title,
      icon: action.icon,
      searchTerms: [action.title, ...action.searchTerms],
      intent: { type: "settings", screen: action.screen },
    });
  }

  const threadItems = threads.map((thread) =>
    threadItem({
      thread,
      projectTitle: projectsByKey.get(projectKey(thread.environmentId, thread.projectId))?.name,
      machineLabel: showMachine ? input.machineLabels.get(thread.environmentId) : undefined,
      current: thread === activeThread,
    }),
  );
  const projectItems = excludeChatProjects(input.projects).map((project): CommandPaletteItem => {
    const machineLabel = showMachine ? input.machineLabels.get(project.environmentId) : undefined;
    return {
      value: `project:${project.environmentId}:${project.id}`,
      kind: "project",
      title: project.name,
      detail: machineLabel ? `${project.cwd} · ${machineLabel}` : project.cwd,
      icon: "folder",
      searchTerms: [project.name, project.cwd],
      intent: { type: "project", environmentId: project.environmentId, projectId: project.id },
    };
  });

  return {
    activeGroups: buildCommandPaletteRootGroups({
      actionItems: actions,
      recentThreadItems: threadItems.slice(0, COMMAND_PALETTE_RECENT_THREAD_LIMIT),
    }),
    searchGroups: [
      { value: "projects-search", label: "Projects", items: projectItems },
      { value: "threads-search", label: "Threads", items: threadItems },
    ],
  };
}

/** The rows a query shows, ranked by the search the web palette uses. */
export function searchCommandPalette(
  sources: CommandPaletteSources,
  query: string,
): CommandPaletteRows<CommandPaletteItem> {
  return buildCommandPaletteRows(
    filterCommandPaletteGroups({
      activeGroups: sources.activeGroups,
      query,
      isInSubmenu: false,
      searchGroups: sources.searchGroups,
    }),
  );
}

/** The highlighted item's position: the remembered item while it is listed, else the first. */
export function commandPaletteHighlightIndex(
  itemValues: ReadonlyArray<string>,
  highlightedValue: string | null,
): number {
  if (itemValues.length === 0) return -1;
  const index = highlightedValue === null ? -1 : itemValues.indexOf(highlightedValue);
  return index < 0 ? 0 : index;
}

/** The item an arrow key moves the highlight to, wrapping at both ends. */
export function stepCommandPaletteHighlight(
  itemValues: ReadonlyArray<string>,
  highlightedValue: string | null,
  direction: 1 | -1,
): string | null {
  if (itemValues.length === 0) return null;
  const index = commandPaletteHighlightIndex(itemValues, highlightedValue);
  return itemValues[(index + direction + itemValues.length) % itemValues.length] ?? null;
}

/**
 * The item a palette key command picks: Return the highlighted one, Command-1
 * through Command-9 the one at that number (the rows show the numbers).
 */
export function commandPaletteItemForKey(
  rows: CommandPaletteRows<CommandPaletteItem>,
  highlightedValue: string | null,
  key: HardwareKeyboardCommand | "return",
): CommandPaletteItem | null {
  const index =
    key === "return"
      ? commandPaletteHighlightIndex(rows.itemValues, highlightedValue)
      : threadJumpIndex(key);
  const rowIndex = index < 0 ? undefined : rows.rowIndexByItemIndex[index];
  const row = rowIndex === undefined ? undefined : rows.rows[rowIndex];
  return row?.kind === "item" ? row.item : null;
}

export const COMMAND_PALETTE_LABEL_ROW_HEIGHT = 30;
export const COMMAND_PALETTE_ITEM_ROW_HEIGHT = 52;

/**
 * Each row's offset and height in the palette list. The heights are fixed, so
 * the list can scroll a highlighted row into view before it has rendered it.
 */
export function commandPaletteRowLayouts(
  rows: ReadonlyArray<CommandPaletteRow<CommandPaletteItem>>,
): ReadonlyArray<{ readonly offset: number; readonly length: number }> {
  let offset = 0;
  return rows.map((row) => {
    const length =
      row.kind === "label" ? COMMAND_PALETTE_LABEL_ROW_HEIGHT : COMMAND_PALETTE_ITEM_ROW_HEIGHT;
    const layout = { offset, length };
    offset += length;
    return layout;
  });
}
