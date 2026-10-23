import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  type FilesystemBrowseEntry,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@ryco/contracts";
import type { Thread } from "../types";
import {
  buildBrowseGroups,
  buildBrowseItemValue,
  buildMessageSearchItems,
  buildThreadActionItems,
  filterBrowseEntries,
  filterCommandPaletteGroups,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

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

describe("thread ID search", () => {
  const UUID_THREAD_ID = "3f2a9b1c-7d4e-4a0b-9c3d-5e6f7a8b9c0d";
  const ID_SHAPED_THREADS = [
    makeThread({ id: ThreadId.make(UUID_THREAD_ID), title: "Fix navbar spacing" }),
    makeThread({
      id: ThreadId.make("thread-agent-control-op-7c1d2e3f-1"),
      title: "Port batch review",
    }),
    makeThread({ id: ThreadId.make("fork-0a1b2c3d4e5f60718293a4b5c6d7e8f9"), title: "Forked run" }),
    makeThread({
      id: ThreadId.make("thread-9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b"),
      title: "Worktree cleanup",
    }),
    makeThread({ id: ThreadId.make("import-claude-session-42"), title: "Session recap" }),
  ];

  function searchThreads(query: string, threads: ReadonlyArray<Thread> = ID_SHAPED_THREADS) {
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query,
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: buildThreadActionItems({
        threads,
        projectTitleById: new Map([[PROJECT_ID, "Project"]]),
        sortOrder: "updated_at",
        icon: null,
        runThread: async (_thread) => undefined,
      }),
    });
    return groups.flatMap((group) => group.items.map((item) => item.value));
  }

  it("finds a thread by its full ID or an ID prefix", () => {
    expect(searchThreads(UUID_THREAD_ID)).toEqual([`thread:${UUID_THREAD_ID}`]);
    expect(searchThreads("  3F2A9B1C ")).toEqual([`thread:${UUID_THREAD_ID}`]);
  });

  it("finds threads whose IDs are not UUIDs", () => {
    for (const thread of ID_SHAPED_THREADS) {
      expect(searchThreads(thread.id)).toEqual([`thread:${thread.id}`]);
    }
    expect(searchThreads("op-7c1d2e3f")).toEqual(["thread:thread-agent-control-op-7c1d2e3f-1"]);
    expect(searchThreads("session-42")).toEqual(["thread:import-claude-session-42"]);
  });

  it("lists a title match before an ID match", () => {
    const titleMatch = makeThread({
      id: ThreadId.make("thread-title-match"),
      title: "Investigate 3f2a9b1c regression",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });

    expect(searchThreads("3f2a9b1c", [...ID_SHAPED_THREADS, titleMatch])).toEqual([
      "thread:thread-title-match",
      `thread:${UUID_THREAD_ID}`,
    ]);
  });

  it("does not match words or short fragments by ID", () => {
    for (const query of ["add", "face", "decade", "thread", "import", "ab12", "3f2a9"]) {
      expect(searchThreads(query), query).toEqual([]);
    }
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
