import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  type FilesystemBrowseEntry,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@ryco/contracts";
import type { CurrentThreadLifecycle } from "../commandPaletteStore";
import type { Thread } from "../types";
import {
  buildBrowseGroups,
  buildBrowseItemValue,
  buildCurrentThreadLifecycleActions,
  buildMessageSearchItems,
  buildSettingsSearchItems,
  buildSnoozeUntilGroups,
  buildThreadActionItems,
  filterBrowseEntries,
  filterCommandPaletteGroups,
  SETTINGS_SEARCH_RESULT_LIMIT,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import { SETTINGS_SECTION_TITLES, type SettingsSearchEntry } from "./settings/settingsSearchIndex";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeBrowseEntry(overrides: Partial<FilesystemBrowseEntry>): FilesystemBrowseEntry {
  return {
    name: "entry",
    fullPath: "/entry",
    ...overrides,
  };
}

function makeBrowseInput(
  entries: FilesystemBrowseEntry[],
  handlers: {
    browseTo?: (name: string) => void;
    browseToPath?: (fullPath: string) => void;
  } = {},
) {
  return {
    browseEntries: entries,
    browseQuery: "~/",
    canBrowseUp: false,
    upIcon: "up-icon",
    directoryIcon: "dir-icon",
    symlinkIcon: "symlink-icon",
    browseUp: () => undefined,
    browseTo: handlers.browseTo ?? (() => undefined),
    browseToPath: handlers.browseToPath ?? (() => undefined),
  };
}

describe("buildThreadActionItems", () => {
  it("orders threads by most recent activity and formats timestamps from updatedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00.000Z"));

    try {
      const items = buildThreadActionItems({
        threads: [
          makeThread({
            id: ThreadId.make("thread-older"),
            title: "Older thread",
            updatedAt: "2026-03-24T12:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.make("thread-newer"),
            title: "Newer thread",
            createdAt: "2026-03-20T00:00:00.000Z",
            updatedAt: "2026-03-20T00:00:00.000Z",
          }),
        ],
        projectTitleById: new Map([[PROJECT_ID, "Project"]]),
        sortOrder: "updated_at",
        icon: null,
        runThread: async (_thread) => undefined,
      });

      expect(items.map((item) => item.value)).toEqual([
        "thread:thread-older",
        "thread:thread-newer",
      ]);
      expect(items[0]?.timestamp).toBe("1d ago");
      expect(items[1]?.timestamp).toBe("5d ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ranks thread title matches ahead of contextual project-name matches", () => {
    const threadItems = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-context-match"),
          title: "Fix navbar spacing",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-title-match"),
          title: "Project kickoff notes",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: threadItems,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("threads-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:thread-title-match",
      "thread:thread-context-match",
    ]);
  });

  it("preserves thread project-name matches when there is no stronger title match", () => {
    const group: CommandPaletteGroup = {
      value: "threads-search",
      label: "Threads",
      items: [
        {
          kind: "action",
          value: "thread:project-context-only",
          searchTerms: ["Fix navbar spacing", "Project"],
          title: "Fix navbar spacing",
          description: "Project",
          icon: null,
          run: async () => undefined,
        },
      ],
    };

    const groups = filterCommandPaletteGroups({
      activeGroups: [group],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["thread:project-context-only"]);
  });

  it("filters archived threads out of thread search items", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          title: "Active thread",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          title: "Archived thread",
          archivedAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    expect(items.map((item) => item.value)).toEqual(["thread:thread-active"]);
  });
});

describe("buildMessageSearchItems", () => {
  it("adds message search results to the Messages group with thread context", async () => {
    const result = {
      environmentId: LOCAL_ENVIRONMENT_ID,
      threadId: ThreadId.make("thread-search-result"),
      messageId: MessageId.make("message-search-result"),
      snippet: "authentication flow matched in the agent response",
      timestamp: "2026-03-24T12:00:00.000Z",
    };
    const runMessage = vi.fn(async () => undefined);
    const messageSearchItems = buildMessageSearchItems({
      searchResults: [result],
      threadTitleById: new Map([[result.threadId, "Auth fix thread"]]),
      projectTitleByThreadId: new Map([[result.threadId, "Project"]]),
      icon: null,
      runMessage,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "authentication",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
      messageSearchItems,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("messages-search");
    const item = groups[0]?.items[0];
    expect(item?.title).toBe("authentication flow matched in the agent response");
    expect(item?.description).toBe("Auth fix thread · Project");

    if (item?.kind !== "action") throw new Error("expected action item");
    await item.run();
    expect(runMessage).toHaveBeenCalledWith(result);
  });
});

describe("buildSnoozeUntilGroups", () => {
  it("lists each snooze time with when it wakes the thread, and snoozes until it", async () => {
    const snooze = vi.fn();
    const groups = buildSnoozeUntilGroups({
      options: [
        {
          id: "hour",
          label: "In 1 hour",
          snoozedUntil: "2026-03-04T13:00:00.000Z",
          timeLabel: "Wed 14:00",
        },
        {
          id: "tomorrow",
          label: "Tomorrow morning",
          snoozedUntil: "2026-03-05T08:00:00.000Z",
          timeLabel: "Thu 09:00",
        },
      ],
      icon: null,
      snooze,
    });

    expect(groups.map((group) => group.label)).toEqual(["Snooze until"]);
    const items = groups[0]?.items ?? [];
    expect(items.map((item) => [item.title, item.description])).toEqual([
      ["In 1 hour", "Wed 14:00"],
      ["Tomorrow morning", "Thu 09:00"],
    ]);
    const tomorrow = items[1];
    if (tomorrow?.kind !== "action") throw new Error("expected action item");
    await tomorrow.run();
    expect(snooze).toHaveBeenCalledWith("2026-03-05T08:00:00.000Z");
  });
});

describe("buildCurrentThreadLifecycleActions", () => {
  const icons = {
    settle: "settle-icon",
    moveToActive: "move-to-active-icon",
    snooze: "snooze-icon",
    snoozeAddon: "snooze-addon-icon",
    archive: "archive-icon",
    markUnread: "mark-unread-icon",
  };

  function makeLifecycle(overrides: Partial<CurrentThreadLifecycle> = {}): CurrentThreadLifecycle {
    return {
      title: "Fix the relay",
      settled: false,
      snoozed: false,
      pending: false,
      disabledReasons: { settle: null, snooze: null, archive: null, markUnread: null },
      snoozeOptions: () => [
        {
          id: "tomorrow",
          label: "Tomorrow morning",
          snoozedUntil: "2026-03-05T08:00:00.000Z",
          timeLabel: "Thu 09:00",
        },
      ],
      setSettled: vi.fn(),
      snooze: vi.fn(),
      archive: vi.fn(),
      markUnread: vi.fn(),
      ...overrides,
    };
  }

  function itemByValue(
    items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>,
    value: string,
  ) {
    const item = items.find((candidate) => candidate.value === value);
    if (!item) throw new Error(`expected ${value}`);
    return item;
  }

  it("offers each action with its shortcut and runs it on the open thread", async () => {
    const lifecycle = makeLifecycle();
    const { items, snoozeUntil } = buildCurrentThreadLifecycleActions({ lifecycle, icons });

    expect(
      items.map((item) => [item.kind, item.title, item.icon, item.shortcutCommand, item.disabled]),
    ).toEqual([
      ["action", "Settle current thread", "settle-icon", "thread.settle", undefined],
      ["submenu", "Snooze current thread…", "snooze-icon", "thread.snooze", undefined],
      ["action", "Archive current thread", "archive-icon", "thread.archive", undefined],
      ["action", "Mark current thread unread", "mark-unread-icon", "thread.markUnread", undefined],
    ]);
    for (const item of items) {
      if (item.kind === "action") await item.run();
    }
    expect(lifecycle.setSettled).toHaveBeenCalledWith(true);
    expect(lifecycle.archive).toHaveBeenCalledOnce();
    expect(lifecycle.markUnread).toHaveBeenCalledOnce();

    // The submenu is the view of snooze times.
    const snoozeItem = itemByValue(items, "action:current-thread-snooze");
    if (snoozeItem.kind !== "submenu") throw new Error("expected submenu item");
    expect(snoozeItem.addonIcon).toBe("snooze-addon-icon");
    expect(snoozeItem.groups).toBe(snoozeUntil?.groups);
    const tomorrow = snoozeUntil?.groups[0]?.items[0];
    expect([tomorrow?.title, tomorrow?.description]).toEqual(["Tomorrow morning", "Thu 09:00"]);
    if (tomorrow?.kind !== "action") throw new Error("expected action item");
    await tomorrow.run();
    expect(lifecycle.snooze).toHaveBeenCalledWith("2026-03-05T08:00:00.000Z");
  });

  it("moves a settled thread back to Active and wakes a snoozed one", async () => {
    const lifecycle = makeLifecycle({ settled: true, snoozed: true });
    const { items, snoozeUntil } = buildCurrentThreadLifecycleActions({ lifecycle, icons });

    const settle = itemByValue(items, "action:current-thread-settle");
    expect([settle.title, settle.icon]).toEqual([
      "Move current thread to Active",
      "move-to-active-icon",
    ]);
    const unsnooze = itemByValue(items, "action:current-thread-snooze");
    expect([unsnooze.kind, unsnooze.title, unsnooze.shortcutCommand]).toEqual([
      "action",
      "Unsnooze current thread",
      "thread.snooze",
    ]);
    expect(snoozeUntil).toBeNull();

    if (settle.kind !== "action" || unsnooze.kind !== "action") {
      throw new Error("expected action items");
    }
    await settle.run();
    await unsnooze.run();
    expect(lifecycle.setSettled).toHaveBeenCalledWith(false);
    expect(lifecycle.snooze).toHaveBeenCalledWith(null);
  });

  it("disables an action that cannot run and says why", () => {
    const { items } = buildCurrentThreadLifecycleActions({
      lifecycle: makeLifecycle({
        disabledReasons: {
          settle: "Wait for the running work to finish.",
          snooze: "Wait for the running work to finish.",
          archive: null,
          markUnread: "Nothing to mark unread yet.",
        },
      }),
      icons,
    });

    expect(items.map((item) => [item.title, item.disabled, item.description])).toEqual([
      ["Settle current thread", true, "Wait for the running work to finish."],
      ["Snooze current thread…", true, "Wait for the running work to finish."],
      ["Archive current thread", undefined, undefined],
      ["Mark current thread unread", true, "Nothing to mark unread yet."],
    ]);
  });

  it("disables all but mark unread while an action awaits the node", () => {
    for (const snoozed of [false, true]) {
      const { items } = buildCurrentThreadLifecycleActions({
        lifecycle: makeLifecycle({ pending: true, snoozed }),
        icons,
      });
      expect(items.map((item) => [item.value, item.disabled])).toEqual([
        ["action:current-thread-settle", true],
        ["action:current-thread-snooze", true],
        ["action:current-thread-archive", true],
        ["action:current-thread-mark-unread", undefined],
      ]);
    }
  });

  it("is found by what each action does", () => {
    const { items } = buildCurrentThreadLifecycleActions({ lifecycle: makeLifecycle(), icons });
    const titlesFor = (query: string) =>
      filterCommandPaletteGroups({
        activeGroups: [{ value: "actions", label: "Actions", items }],
        query,
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: [],
      }).flatMap((group) => group.items.map((item) => item.title));

    expect(titlesFor("settle")).toEqual(["Settle current thread"]);
    expect(titlesFor("snooze")).toEqual(["Snooze current thread…"]);
    expect(titlesFor("archive")).toEqual(["Archive current thread"]);
    expect(titlesFor("unread")).toEqual(["Mark current thread unread"]);
  });
});

describe("buildSettingsSearchItems", () => {
  function settingsEntry(
    title: string,
    overrides: Partial<SettingsSearchEntry> = {},
  ): SettingsSearchEntry {
    return { section: "appearance", owner: "client", title, description: "", ...overrides };
  }

  function actionItem(value: string, title: string): CommandPaletteActionItem {
    return { kind: "action", value, searchTerms: [title], title, icon: null, run: async () => {} };
  }

  function settingsItems(entries: ReadonlyArray<SettingsSearchEntry>, runEntry = vi.fn()) {
    return buildSettingsSearchItems({
      entries,
      sectionTitles: SETTINGS_SECTION_TITLES,
      icon: null,
      runEntry,
    });
  }

  it("lists settings between threads and messages, described by their section", async () => {
    const diffStyle = settingsEntry("Diff style", {
      description: "Preview unified and split layouts for code changes.",
      keywords: "side by side",
    });
    const runEntry = vi.fn();
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "diff",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [actionItem("thread:diff", "Diff review")],
      settingsSearchItems: settingsItems([diffStyle], runEntry),
      messageSearchItems: [actionItem("message:diff", "the diff looks right")],
    });

    expect(groups.map((group) => [group.value, group.label])).toEqual([
      ["threads-search", "Threads"],
      ["settings-search", "Settings"],
      ["messages-search", "Messages"],
    ]);
    const item = groups[1]?.items[0];
    expect(item).toMatchObject({ title: "Diff style", description: "Appearance" });
    if (item?.kind !== "action") throw new Error("expected action item");
    await item.run();
    expect(runEntry).toHaveBeenCalledWith(diffStyle);
  });

  it("shows settings only while typing at the root, never under the actions filter", () => {
    const settingsSearchItems = settingsItems([settingsEntry("Diff style")]);
    const groupsFor = (query: string, isInSubmenu = false) =>
      filterCommandPaletteGroups({
        activeGroups: [],
        query,
        isInSubmenu,
        projectSearchItems: [],
        threadSearchItems: [],
        settingsSearchItems,
      }).map((group) => group.value);

    expect(groupsFor("diff")).toEqual(["settings-search"]);
    expect(groupsFor("")).toEqual([]);
    expect(groupsFor(">diff")).toEqual([]);
    expect(groupsFor("diff", true)).toEqual([]);
  });

  it("keeps the best matches, at most the limit", () => {
    const entries = [
      ...Array.from({ length: SETTINGS_SEARCH_RESULT_LIMIT + 1 }, (_, index) =>
        settingsEntry(`Option ${index}`, { description: "Changes the font." }),
      ),
      settingsEntry("Font"),
    ];
    const [group] = filterCommandPaletteGroups({
      activeGroups: [],
      query: "font",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
      settingsSearchItems: settingsItems(entries),
    });

    expect(group?.items).toHaveLength(SETTINGS_SEARCH_RESULT_LIMIT);
    expect(group?.items[0]?.title).toBe("Font");
  });
});

describe("buildBrowseGroups", () => {
  it("uses the symlink icon for symlinked and aliased entries", () => {
    const groups = buildBrowseGroups(
      makeBrowseInput([
        makeBrowseEntry({ name: "real", fullPath: "/p/real" }),
        makeBrowseEntry({ name: "linked", fullPath: "/p/linked", isSymlink: true }),
        makeBrowseEntry({ name: "aliased", fullPath: "/target", isSymlink: true, isAlias: true }),
      ]),
    );

    const icons = groups[0]?.items.map((item) => item.kind === "action" && item.icon);
    expect(icons).toEqual(["dir-icon", "symlink-icon", "symlink-icon"]);
  });

  it("produces unique values for aliases that share a resolved target", () => {
    const groups = buildBrowseGroups(
      makeBrowseInput([
        makeBrowseEntry({
          name: "alias-a",
          fullPath: "/shared/target",
          isSymlink: true,
          isAlias: true,
        }),
        makeBrowseEntry({
          name: "alias-b",
          fullPath: "/shared/target",
          isSymlink: true,
          isAlias: true,
        }),
      ]),
    );

    const values = groups[0]?.items.map((item) => item.value) ?? [];
    expect(new Set(values).size).toBe(values.length);
  });

  it("routes alias navigation to browseToPath with the resolved fullPath", async () => {
    const browseTo = vi.fn();
    const browseToPath = vi.fn();
    const groups = buildBrowseGroups(
      makeBrowseInput(
        [makeBrowseEntry({ name: "alias", fullPath: "/target", isSymlink: true, isAlias: true })],
        { browseTo, browseToPath },
      ),
    );

    const action = groups[0]?.items[0];
    if (action?.kind !== "action") throw new Error("expected action item");
    await action.run();

    expect(browseToPath).toHaveBeenCalledWith("/target");
    expect(browseTo).not.toHaveBeenCalled();
  });

  it("routes directory and symlink navigation to browseTo with the entry name", async () => {
    const browseTo = vi.fn();
    const browseToPath = vi.fn();
    const groups = buildBrowseGroups(
      makeBrowseInput(
        [
          makeBrowseEntry({ name: "dir", fullPath: "/p/dir" }),
          makeBrowseEntry({ name: "symlink", fullPath: "/p/symlink", isSymlink: true }),
        ],
        { browseTo, browseToPath },
      ),
    );

    const items = groups[0]?.items ?? [];
    for (const item of items) {
      if (item.kind !== "action") throw new Error("expected action item");
      await item.run();
    }

    expect(browseTo.mock.calls).toEqual([["dir"], ["symlink"]]);
    expect(browseToPath).not.toHaveBeenCalled();
  });
});

describe("filterBrowseEntries", () => {
  it("resolves highlightedEntry for non-alias entries", () => {
    const entry = makeBrowseEntry({ name: "dir", fullPath: "/p/dir" });
    const result = filterBrowseEntries({
      browseEntries: [entry],
      browseFilterQuery: "",
      highlightedItemValue: buildBrowseItemValue(entry),
    });
    expect(result.highlightedEntry).toBe(entry);
  });

  it("resolves highlightedEntry for alias entries sharing a resolved target", () => {
    // Two aliases in the same listing pointing at the same target; the
    // filename is what disambiguates them.
    const aliasA = makeBrowseEntry({
      name: "alias-a",
      fullPath: "/shared/target",
      isSymlink: true,
      isAlias: true,
    });
    const aliasB = makeBrowseEntry({
      name: "alias-b",
      fullPath: "/shared/target",
      isSymlink: true,
      isAlias: true,
    });

    const result = filterBrowseEntries({
      browseEntries: [aliasA, aliasB],
      browseFilterQuery: "",
      highlightedItemValue: buildBrowseItemValue(aliasB),
    });

    expect(result.highlightedEntry).toBe(aliasB);
  });

  it("resolves highlightedEntry when the alias name contains a colon", () => {
    // POSIX allows `:` in filenames. A stringy parser that splits on the
    // first `:` after `alias:` would misread the name/fullPath boundary
    // and fail to match. The consumer recomputes the value instead, so
    // the round-trip is robust.
    const alias = makeBrowseEntry({
      name: "weird:name",
      fullPath: "/real/target",
      isSymlink: true,
      isAlias: true,
    });

    const result = filterBrowseEntries({
      browseEntries: [alias],
      browseFilterQuery: "",
      highlightedItemValue: buildBrowseItemValue(alias),
    });

    expect(result.highlightedEntry).toBe(alias);
  });
});
