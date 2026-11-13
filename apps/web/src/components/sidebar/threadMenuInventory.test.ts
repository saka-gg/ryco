import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadMenuInventory,
  moveToProjectTargetOf,
  threadMenuActionIds,
  type ThreadMenuInventoryInput,
} from "./threadMenuInventory";

const base: ThreadMenuInventoryInput = {
  thread: {
    archivedAt: null,
    latestUserMessageAt: "2026-10-01T00:00:00.000Z",
    session: { status: "ready", activeTurnId: null },
    latestTurn: null,
    worktreePath: "/repo-feature",
  },
  isDraft: false,
  isPinned: false,
  splitAvailable: false,
  projectActions: { memberProject: true },
  workspace: null,
};

const conversationIds = (input: ThreadMenuInventoryInput) =>
  buildThreadMenuInventory(input)
    .filter((item) => item.id !== "workspace")
    .map((item) => item.id);

describe("thread menu inventory", () => {
  it("gives the Inbox and the sidebar the same conversation lifecycle actions", () => {
    const sidebar = conversationIds(base);
    const inbox = conversationIds({
      ...base,
      workspace: {
        record: { archivedAt: null, checkoutRemovedAt: null },
        protectedWorkspace: false,
      },
    });
    expect(inbox).toEqual(sidebar);
    expect(sidebar.slice(-3)).toEqual(["stop-session", "archive", "delete"]);
  });

  it("keeps workspace actions in their own submenu, separate from conversation actions", () => {
    const items = buildThreadMenuInventory({
      ...base,
      workspace: {
        record: { archivedAt: null, checkoutRemovedAt: null },
        protectedWorkspace: false,
      },
    });
    const workspace = items.find((item) => item.id === "workspace");
    expect(workspace?.children?.map((item) => item.id)).toEqual([
      "workspace:archive",
      "workspace:delete-workspace",
      "workspace:manage",
    ]);
    expect(
      items
        .filter((item) => item.id !== "workspace")
        .some((item) => item.id.startsWith("workspace:")),
    ).toBe(false);
    expect(threadMenuActionIds(items)).toContain("workspace:delete-workspace");
  });

  it("drops the Workspace submenu once the workspace was deleted", () => {
    const items = buildThreadMenuInventory({
      ...base,
      workspace: {
        record: {
          archivedAt: "2026-10-01T00:00:00.000Z",
          checkoutRemovedAt: "2026-10-01T00:00:00.000Z",
          checkoutRemovalReason: "deleted",
        },
        protectedWorkspace: false,
      },
    });
    expect(items.some((item) => item.id === "workspace")).toBe(false);
  });

  it("offers only management for the main checkout and conversations without a record", () => {
    for (const workspace of [
      { record: { archivedAt: null }, protectedWorkspace: true },
      { record: null, protectedWorkspace: true },
    ]) {
      const items = buildThreadMenuInventory({ ...base, workspace });
      expect(items.find((item) => item.id === "workspace")?.children?.map((c) => c.id)).toEqual([
        "workspace:manage",
      ]);
    }
  });

  it("has no misleading close action; drafts are discarded locally", () => {
    const labels = buildThreadMenuInventory(base).map((item) => item.label);
    expect(labels).not.toContain("Close session");
    expect(labels).not.toContain("Move to Trash");
    expect(labels).toContain("Delete…");
    expect(buildThreadMenuInventory({ ...base, isDraft: true })).toEqual([
      { id: "discard-draft", label: "Discard draft", destructive: true },
    ]);
  });

  it("gives chat rows folder actions and extensions instead of project and workspace items", () => {
    const items = buildThreadMenuInventory({
      ...base,
      workspace: { record: null, protectedWorkspace: true },
      chat: {
        localFolder: true,
        fileManagerLabel: "Finder",
        extensions: [{ id: "promote", label: "Turn into project…" }],
      },
    });
    const ids = items.map((item) => item.id);
    expect(ids).toEqual([
      "pin",
      "rename",
      "mark-unread",
      "chat-reveal-folder",
      "chat-open-folder-in-editor",
      "chat-copy-folder-path",
      "chat-extension:promote",
      "copy-thread-id",
      "stop-session",
      "archive",
      "delete",
    ]);
    expect(items.find((item) => item.id === "rename")?.label).toBe("Rename chat");
    expect(items.find((item) => item.id === "chat-reveal-folder")?.label).toBe(
      "Show folder in Finder",
    );
  });

  it("only copies the folder path of a chat on another machine", () => {
    const ids = threadMenuActionIds(
      buildThreadMenuInventory({
        ...base,
        chat: { localFolder: false, fileManagerLabel: "Files", extensions: [] },
      }),
    );
    expect(ids).toContain("chat-copy-folder-path");
    expect(ids).not.toContain("chat-reveal-folder");
    expect(ids).not.toContain("chat-open-folder-in-editor");
  });

  describe("Move to project", () => {
    const move = (moveToProject: ThreadMenuInventoryInput["moveToProject"]) =>
      buildThreadMenuInventory({
        ...base,
        ...(moveToProject === undefined ? {} : { moveToProject }),
      }).find((item) => item.id === "move-to-project");

    it("lists the node's other projects, then No project, in a submenu", () => {
      const item = move({
        targets: [
          { id: "project-b", name: "Beta" },
          { id: "project-c", name: "Gamma" },
        ],
        offerNoProject: true,
        blockedReason: null,
      });
      expect(item?.label).toBe("Move to project");
      expect(item?.children?.map((entry) => [entry.label, entry.disabled ?? false])).toEqual([
        ["Beta", false],
        ["Gamma", false],
        ["No project", false],
      ]);
      expect(item?.children?.map((entry) => moveToProjectTargetOf(entry.id))).toEqual([
        { kind: "project", projectId: "project-b" },
        { kind: "project", projectId: "project-c" },
        { kind: "no-project" },
      ]);
      // It sits with the thread's own actions, before the lifecycle ones.
      const ids = buildThreadMenuInventory({
        ...base,
        moveToProject: { targets: [], offerNoProject: true, blockedReason: null },
      }).map((entry) => entry.id);
      expect(ids.indexOf("move-to-project")).toBe(ids.indexOf("copy-thread-id") + 1);
    });

    it("says why the thread cannot move now, as a disabled entry that moves nothing", () => {
      const item = move({
        targets: [{ id: "project-b", name: "Beta" }],
        offerNoProject: true,
        blockedReason: "Wait for the turn to finish, or stop it",
      });
      expect(item?.children).toEqual([
        {
          id: "move-to-project:blocked",
          label: "Wait for the turn to finish, or stop it",
          disabled: true,
        },
      ]);
      expect(moveToProjectTargetOf("move-to-project:blocked")).toBeNull();
    });

    it("says when there is nowhere to go, and is absent where moves are not offered", () => {
      expect(move({ targets: [], offerNoProject: false, blockedReason: null })?.children).toEqual([
        { id: "move-to-project:none", label: "No other projects", disabled: true },
      ]);
      expect(move(null)).toBeUndefined();
      expect(move(undefined)).toBeUndefined();
      expect(
        buildThreadMenuInventory({
          ...base,
          isDraft: true,
          moveToProject: { targets: [], offerNoProject: true, blockedReason: null },
        }).some((entry) => entry.id === "move-to-project"),
      ).toBe(false);
    });
  });
});
