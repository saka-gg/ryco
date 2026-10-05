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
});
