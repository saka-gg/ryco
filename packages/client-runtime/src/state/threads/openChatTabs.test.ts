import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  type ScopedThreadRef,
  ThreadId,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { scopeThreadRef } from "../../scoped.ts";
import {
  addOpenChatTab,
  buildOpenChatTabs,
  canKeepOpenChatTab,
  closeOpenChatTab,
  closeOpenChatTabs,
  createOpenChatTabCloseQueue,
  decodeOpenChatTabs,
  encodeOpenChatTabs,
  MAX_OPEN_CHAT_TABS,
  moveOpenChatTab,
  type OpenChatTabSource,
  pruneOpenChatTabs,
  removeOpenChatTab,
  removeOpenChatTabs,
  resolveOpenChatTabCloseTarget,
  resolveOpenChatTabsInCloseScope,
  resolveTabAfterClose,
  stepOpenChatTab,
} from "./openChatTabs.ts";
import type { ArchivedThreadStub, SidebarThreadSummary } from "./types.ts";

const environmentId = EnvironmentId.make("environment-tabs");
const otherEnvironmentId = EnvironmentId.make("environment-other");
const projectId = ProjectId.make("project-tabs");

const ref = (id: string, environment: EnvironmentId = environmentId): ScopedThreadRef =>
  scopeThreadRef(environment, ThreadId.make(id));
const refs = (ids: readonly string[]) => ids.map((id) => ref(id));
const ids = (list: readonly ScopedThreadRef[]) => list.map((entry) => entry.threadId as string);
const tabsOf = (list: readonly string[]) => list.map((id) => ({ ref: ref(id) }));

function summary(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId,
    title: `Chat ${id}`,
    interactionMode: "default",
    session: null,
    createdAt: "2026-10-31T10:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function archivedStub(id: string): ArchivedThreadStub {
  return {
    shellDetail: "archived-stub",
    id: ThreadId.make(id),
    environmentId,
    projectId,
    title: `Chat ${id}`,
    createdAt: "2026-10-31T10:00:00.000Z",
    updatedAt: "2026-10-31T10:00:00.000Z",
    archivedAt: "2026-10-31T11:00:00.000Z",
  } as ArchivedThreadStub;
}

const source = (id: string, value: OpenChatTabSource["summary"]): OpenChatTabSource => ({
  ref: ref(id),
  summary: value,
});

describe("open chat tab list", () => {
  it("keeps an open chat in place and appends new ones", () => {
    const open = refs(["a", "b", "c"]);

    expect(addOpenChatTab(open, ref("a"))).toBe(open);
    expect(ids(addOpenChatTab(open, ref("d")))).toEqual(["a", "b", "c", "d"]);
  });

  it("tells chats of different environments apart", () => {
    const open = refs(["a"]);

    expect(addOpenChatTab(open, ref("a", otherEnvironmentId))).toHaveLength(2);
    expect(removeOpenChatTab(open, ref("a", otherEnvironmentId))).toBe(open);
  });

  it("removes tabs and returns the same list when nothing changes", () => {
    const open = refs(["a", "b", "c"]);

    expect(ids(removeOpenChatTab(open, ref("b")))).toEqual(["a", "c"]);
    expect(ids(removeOpenChatTabs(open, refs(["a", "c"])))).toEqual(["b"]);
    expect(removeOpenChatTab(open, ref("missing"))).toBe(open);
    expect(pruneOpenChatTabs(open, () => true)).toBe(open);
    expect(ids(pruneOpenChatTabs(open, (entry) => entry.threadId !== "a"))).toEqual(["b", "c"]);
  });

  it("moves a dragged tab into the slot of the tab it is dropped on", () => {
    const open = refs(["a", "b", "c", "d"]);
    const move = (from: string, to: string) => ids(moveOpenChatTab(open, ref(from), ref(to)));

    expect(move("a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(move("d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveOpenChatTab(open, ref("b"), ref("b"))).toBe(open);
    expect(moveOpenChatTab(open, ref("b"), ref("missing"))).toBe(open);
  });
});

describe("stored open chat tabs", () => {
  it("round-trips references and nothing else", () => {
    const open = [ref("a"), ref("b", otherEnvironmentId)];
    const text = encodeOpenChatTabs(open);

    expect(JSON.parse(text)).toEqual({
      version: 1,
      tabs: [
        { environmentId, threadId: "a" },
        { environmentId: otherEnvironmentId, threadId: "b" },
      ],
    });
    expect(decodeOpenChatTabs(text)).toEqual(open);
  });

  it("drops duplicates, malformed entries and unknown fields", () => {
    const text = JSON.stringify({
      version: 1,
      tabs: [
        { environmentId, threadId: "a", title: "secret" },
        { environmentId, threadId: " b " },
        { environmentId, threadId: "a" },
        { environmentId, threadId: "" },
        { environmentId: 3, threadId: "c" },
        "d",
        null,
        { environmentId, threadId: "x".repeat(513) },
      ],
    });

    expect(decodeOpenChatTabs(text)).toEqual([ref("a"), ref("b")]);
  });

  it("restores nothing from a missing, corrupt, oversized or unknown document", () => {
    expect(decodeOpenChatTabs(null)).toEqual([]);
    expect(decodeOpenChatTabs("{not json")).toEqual([]);
    expect(decodeOpenChatTabs(JSON.stringify({ version: 2, tabs: [] }))).toEqual([]);
    expect(decodeOpenChatTabs(JSON.stringify({ version: 1, tabs: "a" }))).toEqual([]);
    expect(decodeOpenChatTabs(`${encodeOpenChatTabs(refs(["a"]))}${" ".repeat(140_000)}`)).toEqual(
      [],
    );
  });

  it("caps a stored list", () => {
    const many = Array.from({ length: MAX_OPEN_CHAT_TABS + 5 }, (_, index) => ref(`t${index}`));

    expect(decodeOpenChatTabs(encodeOpenChatTabs(many))).toHaveLength(MAX_OPEN_CHAT_TABS);
  });
});

describe("buildOpenChatTabs", () => {
  it("labels saved chats by title and provider, in open order", () => {
    const tabs = buildOpenChatTabs({
      activeRef: null,
      sources: [
        source("b", summary("b", { providerDriver: ProviderDriverKind.make("claudeAgent") })),
        source("a", summary("a", { title: "Refactor rows" })),
      ],
    });

    expect(tabs).toEqual([
      expect.objectContaining({
        key: `${environmentId}:b`,
        title: "Chat b",
        providerDriver: "claudeAgent",
      }),
      expect.objectContaining({ key: `${environmentId}:a`, title: "Refactor rows" }),
    ]);
  });

  it("hides unsent drafts and chats the store has no summary for", () => {
    const tabs = buildOpenChatTabs({
      activeRef: ref("draft"),
      sources: [source("draft", undefined), source("saved", summary("saved"))],
    });

    expect(tabs.map((tab) => tab.ref.threadId)).toEqual(["saved"]);
  });

  it("hides archived chats unless one is on screen", () => {
    const sources = [
      source("archived", summary("archived", { archivedAt: "2026-10-31T11:00:00.000Z" })),
      source("stub", archivedStub("stub")),
      source("live", summary("live")),
    ];

    expect(buildOpenChatTabs({ activeRef: null, sources }).map((tab) => tab.ref.threadId)).toEqual([
      "live",
    ]);
    expect(
      buildOpenChatTabs({ activeRef: ref("archived"), sources }).map((tab) => tab.ref.threadId),
    ).toEqual(["archived", "live"]);
  });

  it("spins while a chat works or connects, not while it waits on you", () => {
    const tabs = buildOpenChatTabs({
      activeRef: null,
      sources: [
        source("idle", summary("idle")),
        source(
          "working",
          summary("working", {
            latestTurn: { state: "running" } as SidebarThreadSummary["latestTurn"],
          }),
        ),
        source(
          "connecting",
          summary("connecting", {
            session: { status: "connecting" } as SidebarThreadSummary["session"],
          }),
        ),
        source("background", summary("background", { backgroundLiveness: "working" })),
        source(
          "approval",
          summary("approval", {
            hasPendingApprovals: true,
            latestTurn: { state: "running" } as SidebarThreadSummary["latestTurn"],
          }),
        ),
      ],
    });

    expect(tabs.map((tab) => [tab.ref.threadId, tab.isRunning])).toEqual([
      ["idle", false],
      ["working", true],
      ["connecting", true],
      ["background", true],
      ["approval", false],
    ]);
  });
});

describe("canKeepOpenChatTab", () => {
  it("keeps saved chats and registered drafts, drops archived and unknown ones", () => {
    expect(canKeepOpenChatTab(summary("a"), false)).toBe(true);
    expect(canKeepOpenChatTab(undefined, true)).toBe(true);
    expect(canKeepOpenChatTab(undefined, false)).toBe(false);
    expect(canKeepOpenChatTab(archivedStub("a"), false)).toBe(false);
    expect(
      canKeepOpenChatTab(summary("a", { archivedAt: "2026-10-31T11:00:00.000Z" }), false),
    ).toBe(false);
  });
});

describe("close successors", () => {
  const tabs = tabsOf(["a", "b", "c"]);

  it("takes the right neighbour, else the left one", () => {
    expect(resolveTabAfterClose(["a", "c"], 1)).toBe("c");
    expect(resolveTabAfterClose(["a", "b"], 2)).toBe("b");
    expect(resolveTabAfterClose([], 0)).toBeNull();
  });

  it("keeps the current chat when a background tab closes", () => {
    expect(
      resolveOpenChatTabCloseTarget({ tabs, closedRef: ref("a"), activeRef: ref("b") }),
    ).toBeNull();
    expect(
      resolveOpenChatTabCloseTarget({ tabs, closedRef: ref("a"), activeRef: null }),
    ).toBeNull();
  });

  it.each([
    ["a middle tab moves right", "b", "c"],
    ["the last tab moves left", "c", "b"],
  ])("closing the active tab: %s", (_label, closed, next) => {
    expect(
      resolveOpenChatTabCloseTarget({ tabs, closedRef: ref(closed), activeRef: ref(closed) }),
    ).toEqual({ ref: ref(next) });
  });

  it("reports no successor when the only tab closes", () => {
    expect(
      resolveOpenChatTabCloseTarget({
        tabs: tabsOf(["a"]),
        closedRef: ref("a"),
        activeRef: ref("a"),
      }),
    ).toEqual({ ref: null });
  });
});

describe("closeOpenChatTab", () => {
  // A route that follows successful navigations, unless a guard blocks leaving it.
  function harness(input: { active: string; blocked?: boolean; freshChatError?: string }) {
    let route: ScopedThreadRef | null = ref(input.active);
    const closeTab = vi.fn();
    const openTab = vi.fn(async (next: ScopedThreadRef) => {
      if (!input.blocked) route = next;
    });
    const replaceLastTab = vi.fn(async () => {
      if (input.freshChatError) return { ok: false as const, error: input.freshChatError };
      // A fresh chat is a draft route: no thread route at all.
      route = null;
      return { ok: true as const };
    });
    const close = (list: readonly string[], closed: string) =>
      closeOpenChatTab({
        tabs: tabsOf(list),
        closedRef: ref(closed),
        activeRef: ref(input.active),
        closeTab,
        openTab,
        replaceLastTab,
        readRouteRef: () => route,
      });
    return { close, closeTab, openTab, replaceLastTab };
  }

  it("closes a background tab without navigating", async () => {
    const { close, closeTab, openTab } = harness({ active: "b" });

    await expect(close(["a", "b"], "a")).resolves.toEqual({ ok: true });
    expect(closeTab).toHaveBeenCalledWith(ref("a"));
    expect(openTab).not.toHaveBeenCalled();
  });

  it("moves to the successor before closing the active tab", async () => {
    const { close, closeTab, openTab } = harness({ active: "b" });

    await close(["a", "b", "c"], "b");
    expect(openTab).toHaveBeenCalledWith(ref("c"));
    expect(closeTab).toHaveBeenCalledWith(ref("b"));
    expect(openTab.mock.invocationCallOrder[0]).toBeLessThan(closeTab.mock.invocationCallOrder[0]!);
  });

  it("keeps the active tab when navigation is blocked", async () => {
    const { close, closeTab, openTab } = harness({ active: "b", blocked: true });

    await expect(close(["a", "b"], "b")).resolves.toEqual({ ok: true });
    expect(openTab).toHaveBeenCalledWith(ref("a"));
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("opens a fresh chat for the last tab, keeping the tab when that fails", async () => {
    const opened = harness({ active: "a" });
    await opened.close(["a"], "a");
    expect(opened.replaceLastTab).toHaveBeenCalledOnce();
    expect(opened.closeTab).toHaveBeenCalledWith(ref("a"));

    const failed = harness({
      active: "a",
      freshChatError: "Reconnect to this node and try again.",
    });
    await expect(failed.close(["a"], "a")).resolves.toEqual({
      ok: false,
      error: "Reconnect to this node and try again.",
    });
    expect(failed.closeTab).not.toHaveBeenCalled();
  });

  it("keeps the last tab when nothing can take its place", async () => {
    const closeTab = vi.fn();
    await closeOpenChatTab({
      tabs: tabsOf(["a"]),
      closedRef: ref("a"),
      activeRef: ref("a"),
      closeTab,
      openTab: vi.fn(),
      readRouteRef: () => ref("a"),
    });

    expect(closeTab).not.toHaveBeenCalled();
  });
});

describe("resolveOpenChatTabsInCloseScope", () => {
  const inScope = (list: readonly string[], anchor: string) => ({
    left: ids(resolveOpenChatTabsInCloseScope(tabsOf(list), ref(anchor), "left")),
    right: ids(resolveOpenChatTabsInCloseScope(tabsOf(list), ref(anchor), "right")),
    others: ids(resolveOpenChatTabsInCloseScope(tabsOf(list), ref(anchor), "others")),
  });

  it("splits the neighbours of a middle tab by side and never includes the tab itself", () => {
    expect(inScope(["a", "b", "c", "d"], "b")).toEqual({
      left: ["a"],
      right: ["c", "d"],
      others: ["a", "c", "d"],
    });
  });

  it("has nothing on the outer side of the first and last tab", () => {
    expect(inScope(["a", "b", "c"], "a")).toEqual({
      left: [],
      right: ["b", "c"],
      others: ["b", "c"],
    });
    expect(inScope(["a", "b", "c"], "c")).toEqual({
      left: ["a", "b"],
      right: [],
      others: ["a", "b"],
    });
  });

  it("has nothing to close around a lone tab or a tab that is no longer open", () => {
    expect(inScope(["a"], "a")).toEqual({ left: [], right: [], others: [] });
    expect(inScope(["a", "b"], "gone")).toEqual({ left: [], right: [], others: [] });
  });
});

describe("closeOpenChatTabs", () => {
  function harness(input: { active: string; blocked?: boolean }) {
    let route = ref(input.active);
    const closeTabs = vi.fn();
    const openTab = vi.fn(async (next: ScopedThreadRef) => {
      if (!input.blocked) route = next;
    });
    const close = (closed: readonly string[], kept: string) =>
      closeOpenChatTabs({
        closedRefs: refs(closed),
        keptRef: ref(kept),
        activeRef: ref(input.active),
        closeTabs,
        openTab,
        readRouteRef: () => route,
      });
    return { close, closeTabs, openTab };
  }

  it("closes background tabs together without navigating", async () => {
    const { close, closeTabs, openTab } = harness({ active: "a" });

    await close(["b", "c"], "a");
    expect(openTab).not.toHaveBeenCalled();
    expect(closeTabs).toHaveBeenCalledExactlyOnceWith(refs(["b", "c"]));
  });

  it("moves to the kept tab before closing the chat on screen", async () => {
    const { close, closeTabs, openTab } = harness({ active: "c" });

    await close(["b", "c"], "a");
    expect(openTab).toHaveBeenCalledExactlyOnceWith(ref("a"));
    expect(closeTabs).toHaveBeenCalledExactlyOnceWith(refs(["b", "c"]));
    expect(openTab.mock.invocationCallOrder[0]).toBeLessThan(
      closeTabs.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps the tab of a chat the route could not leave", async () => {
    const { close, closeTabs } = harness({ active: "c", blocked: true });

    await close(["b", "c"], "a");
    expect(closeTabs).toHaveBeenCalledExactlyOnceWith(refs(["b"]));
  });
});

describe("createOpenChatTabCloseQueue", () => {
  it("closes the successor when its X is clicked while the first close is still navigating", async () => {
    // Live app state: the stored list and the route. A chat the route lands on records itself as
    // open again, as the chat header does.
    const open = refs(["a", "b", "c"]);
    let route = ref("a");
    const has = (entry: ScopedThreadRef) => open.some((item) => item.threadId === entry.threadId);
    const openTab = async (next: ScopedThreadRef) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      route = next;
      if (!has(next)) open.push(next);
    };
    const rendered = tabsOf(["a", "b", "c"]);
    const enqueueClose = createOpenChatTabCloseQueue();
    const close = (closed: string) =>
      enqueueClose(() =>
        closeOpenChatTab({
          tabs: rendered.filter((tab) => has(tab.ref)),
          closedRef: ref(closed),
          activeRef: route,
          closeTab: (gone) =>
            open.splice(
              open.findIndex((item) => item.threadId === gone.threadId),
              1,
            ),
          openTab,
          readRouteRef: () => route,
        }),
      );

    // Both X clicks land before the first navigation settles.
    await Promise.all([close("a"), close("b")]);

    expect(ids(open)).toEqual(["c"]);
    expect(route).toEqual(ref("c"));
  });

  it("keeps running after a close that throws", async () => {
    const enqueue = createOpenChatTabCloseQueue();
    const failing = enqueue(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    await expect(enqueue(async () => "next")).resolves.toBe("next");
  });
});

describe("stepOpenChatTab", () => {
  const tabs = tabsOf(["a", "b", "c"]);
  const step = (shown: string | null, direction: "forward" | "backward") =>
    stepOpenChatTab({ tabs, shownRef: shown === null ? null : ref(shown), direction })?.threadId;

  it("walks the strip and wraps at either end", () => {
    expect(step("a", "forward")).toBe("b");
    expect(step("c", "forward")).toBe("a");
    expect(step("a", "backward")).toBe("c");
    expect(step("b", "backward")).toBe("a");
  });

  it("starts at an end when no tab is shown", () => {
    expect(step(null, "forward")).toBe("a");
    expect(step(null, "backward")).toBe("c");
    expect(step("gone", "forward")).toBe("a");
    expect(stepOpenChatTab({ tabs: [], shownRef: null, direction: "forward" })).toBeNull();
  });
});
