import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadMenuInventory,
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
    expect(sidebar.slice(-3)).toEqual(["stop-session", "archive", "trash"]);
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
      "workspace:remove-checkout",
      "workspace:delete-workspace",
      "workspace:manage",
    ]);
    expect(
      items
        .filter((item) => item.id !== "workspace")
        .some((item) => item.id.startsWith("workspace:")),
    ).toBe(false);
    expect(threadMenuActionIds(items)).toContain("workspace:remove-checkout");
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
    expect(labels).not.toContain("Delete thread");
    expect(labels).toContain("Move to Trash");
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
      "trash",
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
});
