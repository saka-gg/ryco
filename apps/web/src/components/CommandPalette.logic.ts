import {
  type EnvironmentId,
  type KeybindingCommand,
  type FilesystemBrowseEntry,
  type OrchestrationThreadMessageSearchResult,
} from "@ryco/contracts";
import type { ThreadLifecycleAction } from "@ryco/client-runtime/state/threads";
import type { SidebarThreadSortOrder } from "@ryco/contracts/settings";
import { type ReactNode } from "react";
import type { CurrentThreadLifecycle, ThreadSnoozeOption } from "../commandPaletteStore";
import { sortThreads } from "../lib/threadSort";
import type { SettingsSectionId } from "../settingsDialogStore";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { type Project, type SidebarThreadSummary, type Thread } from "../types";
import type { SettingsSearchEntry } from "./settings/settingsSearchIndex";

export const RECENT_THREAD_LIMIT = 12;
/** Settings results show only while typing, under Threads, at most this many. */
export const SETTINGS_SEARCH_RESULT_LIMIT = 8;
export const ITEM_ICON_CLASS = "size-4 text-muted-foreground/80";
export const ADDON_ICON_CLASS = "size-4";

export interface CommandPaletteItem {
  readonly kind: "action" | "submenu";
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: ReactNode;
  readonly description?: string;
  readonly timestamp?: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  /** Optional content rendered inline before the title text. */
  readonly titleLeadingContent?: ReactNode;
  /** Optional content rendered inline after the title text (before the timestamp). */
  readonly titleTrailingContent?: ReactNode;
  readonly shortcutCommand?: KeybindingCommand;
}

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly kind: "action";
  readonly keepOpen?: boolean;
  readonly run: () => Promise<void>;
}

export interface CommandPaletteSubmenuItem extends CommandPaletteItem {
  readonly kind: "submenu";
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
}

export interface CommandPaletteView {
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

export type CommandPaletteMode = "root" | "root-browse" | "submenu" | "submenu-browse";

// Browse palette values have two shapes:
//   - `browse:${fullPath}` for regular directories and symlinks
//   - `browse:alias:${name}:${fullPath}` for macOS Finder aliases, where two
//     aliases in the same listing can resolve to the same target and we need
//     the visible name to disambiguate them.
// The consumer never parses this string — it recomputes the value via
// buildBrowseItemValue(entry) and compares. That way filename characters
// (colons, spaces, …) never collide with the `:` delimiter.
export function buildBrowseItemValue(
  entry: Pick<FilesystemBrowseEntry, "name" | "fullPath" | "isAlias">,
): string {
  return entry.isAlias
    ? `browse:alias:${entry.name}:${entry.fullPath}`
    : `browse:${entry.fullPath}`;
}

export function filterBrowseEntries(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  browseFilterQuery: string;
  highlightedItemValue: string | null;
}): {
  filteredEntries: FilesystemBrowseEntry[];
  highlightedEntry: FilesystemBrowseEntry | null;
  exactEntry: FilesystemBrowseEntry | null;
} {
  const lowerFilter = input.browseFilterQuery.toLowerCase();
  const showHidden = input.browseFilterQuery.startsWith(".");

  const filteredEntries = input.browseEntries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(lowerFilter) &&
      (showHidden || !entry.name.startsWith(".")),
  );

  let highlightedEntry: FilesystemBrowseEntry | null = null;
  const highlighted = input.highlightedItemValue;
  if (highlighted && highlighted.startsWith("browse:")) {
    highlightedEntry =
      filteredEntries.find((entry) => buildBrowseItemValue(entry) === highlighted) ?? null;
  }

  const exactEntry =
    input.browseFilterQuery.length > 0
      ? (filteredEntries.find((entry) => entry.name === input.browseFilterQuery) ?? null)
      : null;

  return { filteredEntries, highlightedEntry, exactEntry };
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildProjectActionItems(input: {
  projects: ReadonlyArray<Project>;
  valuePrefix: string;
  icon: (project: Project) => ReactNode;
  runProject: (project: Project) => Promise<void>;
}): CommandPaletteActionItem[] {
  return input.projects.map((project) => ({
    kind: "action",
    value: `${input.valuePrefix}:${project.environmentId}:${project.id}`,
    searchTerms: [project.name, project.cwd],
    title: project.name,
    description: project.cwd,
    icon: input.icon(project),
    run: async () => {
      await input.runProject(project);
    },
  }));
}

export type BuildThreadActionItemsThread = Pick<
  SidebarThreadSummary,
  "archivedAt" | "branch" | "createdAt" | "environmentId" | "id" | "projectId" | "title"
> & {
  updatedAt?: string | undefined;
  latestUserMessageAt?: string | null;
};

export function buildThreadActionItems<TThread extends BuildThreadActionItemsThread>(input: {
  threads: ReadonlyArray<TThread>;
  activeThreadId?: Thread["id"];
  projectTitleById: ReadonlyMap<Project["id"], string>;
  sortOrder: SidebarThreadSortOrder;
  icon: ReactNode;
  /** Optional content rendered inline before the title text per-thread. */
  renderLeadingContent?: (thread: TThread) => ReactNode;
  /** Optional content rendered inline after the title text per-thread. */
  renderTrailingContent?: (thread: TThread) => ReactNode;
  runThread: (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) => Promise<void>;
  limit?: number;
}): CommandPaletteActionItem[] {
  const sortedThreads = sortThreads(
    input.threads.filter((thread) => thread.archivedAt === null),
    input.sortOrder,
  );
  const visibleThreads =
    input.limit === undefined ? sortedThreads : sortedThreads.slice(0, input.limit);

  return visibleThreads.map((thread) => {
    const projectTitle = input.projectTitleById.get(thread.projectId);
    const descriptionParts: string[] = [];

    if (projectTitle) {
      descriptionParts.push(projectTitle);
    }
    if (thread.branch) {
      descriptionParts.push(`#${thread.branch}`);
    }
    if (thread.id === input.activeThreadId) {
      descriptionParts.push("Current thread");
    }

    const leadingContent = input.renderLeadingContent?.(thread);
    const trailingContent = input.renderTrailingContent?.(thread);

    return Object.assign(
      {
        kind: "action" as const,
        value: `thread:${thread.id}`,
        searchTerms: [thread.title, projectTitle ?? ``, thread.branch ?? ``],
        title: thread.title,
        description: descriptionParts.join(` · `),
        timestamp: formatRelativeTimeLabel(
          thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
        ),
        icon: input.icon,
      },
      leadingContent ? { titleLeadingContent: leadingContent } : {},
      trailingContent ? { titleTrailingContent: trailingContent } : {},
      {
        run: async () => {
          await input.runThread(thread);
        },
      },
    );
  });
}

function rankSearchFieldMatch(field: string, normalizedQuery: string): number {
  const normalizedField = normalizeSearchText(field);
  if (normalizedField.length === 0 || !normalizedField.includes(normalizedQuery)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (normalizedField === normalizedQuery) {
    return 3;
  }
  if (normalizedField.startsWith(normalizedQuery)) {
    return 2;
  }
  return 1;
}

function rankCommandPaletteItemMatch(
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
  normalizedQuery: string,
): number {
  const terms = item.searchTerms.filter((term) => term.length > 0);
  if (terms.length === 0) {
    return 0;
  }

  for (const [index, field] of terms.entries()) {
    const fieldRank = rankSearchFieldMatch(field, normalizedQuery);
    if (fieldRank !== Number.NEGATIVE_INFINITY) {
      return 1_000 - index * 100 + fieldRank;
    }
  }

  return 0;
}

export type CommandPaletteMessageSearchResult = OrchestrationThreadMessageSearchResult & {
  readonly environmentId: EnvironmentId;
};

export function buildMessageSearchItems(input: {
  searchResults: ReadonlyArray<CommandPaletteMessageSearchResult>;
  threadTitleById: ReadonlyMap<Thread["id"], string>;
  projectTitleByThreadId: ReadonlyMap<Thread["id"], string>;
  icon: ReactNode;
  runMessage: (result: CommandPaletteMessageSearchResult) => Promise<void>;
}): CommandPaletteActionItem[] {
  return input.searchResults.map((result) => {
    const threadTitle = input.threadTitleById.get(result.threadId) ?? "Thread";
    const projectTitle = input.projectTitleByThreadId.get(result.threadId);
    const description = [threadTitle, projectTitle].filter(Boolean).join(" · ");

    return {
      kind: "action" as const,
      value: `message:${result.environmentId}:${result.threadId}:${result.messageId}`,
      searchTerms: [result.snippet, threadTitle, projectTitle ?? ""],
      title: result.snippet,
      description,
      timestamp: formatRelativeTimeLabel(result.timestamp),
      icon: input.icon,
      run: async () => {
        await input.runMessage(result);
      },
    };
  });
}

export function buildSettingsSearchItems(input: {
  entries: ReadonlyArray<SettingsSearchEntry>;
  sectionTitles: Readonly<Record<SettingsSectionId, string>>;
  icon: ReactNode;
  runEntry: (entry: SettingsSearchEntry) => void;
}): CommandPaletteActionItem[] {
  return input.entries.map((entry) => ({
    kind: "action" as const,
    value: `settings:${entry.owner}:${entry.section}:${entry.title}`,
    searchTerms: [entry.title, entry.description, entry.keywords ?? ""],
    title: entry.title,
    description: input.sectionTitles[entry.section],
    icon: input.icon,
    run: async () => {
      input.runEntry(entry);
    },
  }));
}

/** The open thread's "Snooze until" view: each time, with when it wakes the thread. */
export function buildSnoozeUntilGroups(input: {
  options: ReadonlyArray<ThreadSnoozeOption>;
  icon: ReactNode;
  snooze: (snoozedUntil: string) => void;
}): CommandPaletteGroup[] {
  return [
    {
      value: "snooze-until",
      label: "Snooze until",
      items: input.options.map((option) => ({
        kind: "action" as const,
        value: `snooze-until:${option.id}`,
        searchTerms: [option.label, option.timeLabel],
        title: option.label,
        description: option.timeLabel,
        icon: input.icon,
        run: async () => {
          input.snooze(option.snoozedUntil);
        },
      })),
    },
  ];
}

export interface CurrentThreadLifecycleIcons {
  readonly settle: ReactNode;
  readonly moveToActive: ReactNode;
  readonly snooze: ReactNode;
  readonly snoozeAddon: ReactNode;
  readonly archive: ReactNode;
  readonly markUnread: ReactNode;
}

/**
 * Settle, snooze, archive and mark unread for the open thread, disabled with
 * the Inbox's reason when they cannot run (and all but mark unread while one
 * is pending). Settle and snooze toggle like the Inbox row's buttons.
 * `snoozeUntil` is the view of snooze times, null while the thread is snoozed.
 */
export function buildCurrentThreadLifecycleActions(input: {
  lifecycle: CurrentThreadLifecycle;
  icons: CurrentThreadLifecycleIcons;
}): {
  items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  snoozeUntil: CommandPaletteView | null;
} {
  const { lifecycle, icons } = input;
  const unavailable = (action: ThreadLifecycleAction) => {
    const reason = lifecycle.disabledReasons[action];
    if (reason !== null) return { description: reason, disabled: true };
    return lifecycle.pending && action !== "markUnread" ? { disabled: true } : {};
  };
  const snoozeUntil: CommandPaletteView | null = lifecycle.snoozed
    ? null
    : {
        addonIcon: icons.snoozeAddon,
        groups: buildSnoozeUntilGroups({
          options: lifecycle.snoozeOptions(),
          icon: icons.snooze,
          snooze: lifecycle.snooze,
        }),
      };
  const snoozeSearchTerms = ["snooze", "unsnooze", "later", "remind", "wake", "current thread"];
  const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
    {
      kind: "action",
      value: "action:current-thread-settle",
      searchTerms: ["settle", "done", "move to active", "unsettle", "active", "current thread"],
      title: lifecycle.settled ? "Move current thread to Active" : "Settle current thread",
      icon: lifecycle.settled ? icons.moveToActive : icons.settle,
      shortcutCommand: "thread.settle",
      ...unavailable("settle"),
      run: async () => {
        lifecycle.setSettled(!lifecycle.settled);
      },
    },
    snoozeUntil === null
      ? {
          kind: "action",
          value: "action:current-thread-snooze",
          searchTerms: snoozeSearchTerms,
          title: "Unsnooze current thread",
          icon: icons.snooze,
          shortcutCommand: "thread.snooze",
          ...unavailable("snooze"),
          run: async () => {
            lifecycle.snooze(null);
          },
        }
      : {
          kind: "submenu",
          value: "action:current-thread-snooze",
          searchTerms: snoozeSearchTerms,
          title: "Snooze current thread…",
          icon: icons.snooze,
          shortcutCommand: "thread.snooze",
          ...unavailable("snooze"),
          ...snoozeUntil,
        },
    {
      kind: "action",
      value: "action:current-thread-archive",
      searchTerms: ["archive", "hide", "current thread"],
      title: "Archive current thread",
      icon: icons.archive,
      shortcutCommand: "thread.archive",
      ...unavailable("archive"),
      run: async () => {
        lifecycle.archive();
      },
    },
    {
      kind: "action",
      value: "action:current-thread-mark-unread",
      searchTerms: ["mark unread", "unread", "unseen", "current thread"],
      title: "Mark current thread unread",
      icon: icons.markUnread,
      shortcutCommand: "thread.markUnread",
      ...unavailable("markUnread"),
      run: async () => {
        lifecycle.markUnread();
      },
    },
  ];
  return { items, snoozeUntil };
}

export function filterCommandPaletteGroups(input: {
  activeGroups: ReadonlyArray<CommandPaletteGroup>;
  query: string;
  isInSubmenu: boolean;
  projectSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  threadSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  settingsSearchItems?: ReadonlyArray<CommandPaletteActionItem>;
  messageSearchItems?: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const isActionsFilter = input.query.startsWith(">");
  const searchQuery = isActionsFilter ? input.query.slice(1) : input.query;
  const normalizedQuery = normalizeSearchText(searchQuery);

  if (normalizedQuery.length === 0) {
    if (isActionsFilter) {
      return input.activeGroups.filter((group) => group.value === "actions");
    }
    return [...input.activeGroups];
  }

  let baseGroups = [...input.activeGroups];
  if (isActionsFilter) {
    baseGroups = baseGroups.filter((group) => group.value === "actions");
  } else if (!input.isInSubmenu) {
    baseGroups = baseGroups.filter((group) => group.value !== "recent-threads");
  }

  const searchableGroups = [...baseGroups];
  if (!input.isInSubmenu && !isActionsFilter) {
    if (input.projectSearchItems.length > 0) {
      searchableGroups.push({
        value: "projects-search",
        label: "Projects",
        items: input.projectSearchItems,
      });
    }
    if (input.threadSearchItems.length > 0) {
      searchableGroups.push({
        value: "threads-search",
        label: "Threads",
        items: input.threadSearchItems,
      });
    }
    if (input.settingsSearchItems && input.settingsSearchItems.length > 0) {
      searchableGroups.push({
        value: "settings-search",
        label: "Settings",
        items: input.settingsSearchItems,
      });
    }
    if (input.messageSearchItems && input.messageSearchItems.length > 0) {
      searchableGroups.push({
        value: "messages-search",
        label: "Messages",
        items: input.messageSearchItems,
      });
    }
  }

  return searchableGroups.flatMap((group) => {
    const items = group.items
      .map((item, index) => {
        const haystack = normalizeSearchText(item.searchTerms.join(" "));
        if (!haystack.includes(normalizedQuery)) {
          return null;
        }

        return {
          item,
          index,
          rank: rankCommandPaletteItemMatch(item, normalizedQuery),
        };
      })
      .filter(
        (entry): entry is { item: (typeof group.items)[number]; index: number; rank: number } =>
          entry !== null,
      )
      .toSorted((left, right) => right.rank - left.rank || left.index - right.index)
      .slice(0, group.value === "settings-search" ? SETTINGS_SEARCH_RESULT_LIMIT : undefined)
      .map((entry) => entry.item);

    if (items.length === 0) {
      return [];
    }

    return [{ value: group.value, label: group.label, items }];
  });
}

export function buildBrowseGroups(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  browseQuery: string;
  canBrowseUp: boolean;
  upIcon: ReactNode;
  directoryIcon: ReactNode;
  symlinkIcon: ReactNode;
  browseUp: () => void;
  browseTo: (name: string) => void;
  browseToPath: (fullPath: string) => void;
}): CommandPaletteGroup[] {
  const items: CommandPaletteActionItem[] = [];

  if (input.canBrowseUp) {
    items.push({
      kind: "action",
      value: "browse:up",
      searchTerms: [input.browseQuery, ".."],
      title: "..",
      icon: input.upIcon,
      keepOpen: true,
      run: async () => {
        input.browseUp();
      },
    });
  }

  for (const entry of input.browseEntries) {
    items.push({
      kind: "action",
      value: buildBrowseItemValue(entry),
      searchTerms: [input.browseQuery, entry.fullPath, entry.name],
      title: entry.name,
      icon: entry.isSymlink ? input.symlinkIcon : input.directoryIcon,
      keepOpen: true,
      run: async () => {
        // Finder aliases resolve to a target elsewhere on disk. Appending the
        // alias file name to the current path would fail to readdir, so we
        // jump straight to the resolved fullPath.
        if (entry.isAlias) {
          input.browseToPath(entry.fullPath);
        } else {
          input.browseTo(entry.name);
        }
      },
    });
  }

  return [{ value: "directories", label: "Directories", items }];
}

export function getCommandPaletteMode(input: {
  currentView: CommandPaletteView | null;
  isBrowsing: boolean;
}): CommandPaletteMode {
  if (input.currentView) {
    return input.isBrowsing ? "submenu-browse" : "submenu";
  }
  return input.isBrowsing ? "root-browse" : "root";
}

export function buildRootGroups(input: {
  actionItems: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  recentThreadItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const groups: CommandPaletteGroup[] = [];
  if (input.actionItems.length > 0) {
    groups.push({ value: "actions", label: "Actions", items: input.actionItems });
  }
  if (input.recentThreadItems.length > 0) {
    groups.push({
      value: "recent-threads",
      label: "Recent Threads",
      items: input.recentThreadItems,
    });
  }
  return groups;
}

export function getCommandPaletteInputPlaceholder(mode: CommandPaletteMode): string {
  switch (mode) {
    case "root":
      return "Search commands, projects, and threads...";
    case "root-browse":
      return "Enter project path (e.g. ~/projects/my-app)";
    case "submenu":
      return "Search...";
    case "submenu-browse":
      return "Enter path (e.g. ~/projects/my-app)";
  }
}
