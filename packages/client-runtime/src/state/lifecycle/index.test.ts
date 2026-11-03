import { describe, expect, it } from "vite-plus/test";

import {
  isThreadArchiveBlockedByTurn,
  isWorkspaceDeleted,
  isWorkspaceReviewAction,
  listThreadLifecycleActions,
  listWorkspaceLifecycleActions,
  parseWorkspaceReviewAction,
  WORKSPACE_REVIEW_ACTIONS,
  workspaceActionRequest,
  type ThreadLifecycleSubject,
} from "./index.ts";

const thread = (overrides: Partial<ThreadLifecycleSubject> = {}): ThreadLifecycleSubject => ({
  archivedAt: null,
  latestUserMessageAt: "2026-10-01T00:00:00.000Z",
  session: null,
  latestTurn: null,
  ...overrides,
});
const ids = (subject: ThreadLifecycleSubject) =>
  listThreadLifecycleActions(subject).map((a) => a.id);

describe("conversation lifecycle actions", () => {
  it("separates interrupt, stop, archive and delete", () => {
    expect(ids(thread({ session: { status: "running", activeTurnId: "turn" } }))).toEqual([
      "interrupt-turn",
      "archive",
      "delete",
    ]);
    expect(ids(thread({ session: { status: "ready", activeTurnId: null } }))).toEqual([
      "stop-session",
      "archive",
      "delete",
    ]);
    expect(ids(thread({ session: { status: "stopped" } }))).toEqual(["archive", "delete"]);
    expect(ids(thread({ archivedAt: "2026-10-01T00:00:00.000Z" }))).toEqual([
      "unarchive",
      "delete",
    ]);
    // A never-used thread cannot be archived, but it can still be deleted.
    expect(ids(thread({ latestUserMessageAt: null }))).toEqual(["delete"]);
  });

  it("offers Archive on a fork that holds only its inherited conversation", () => {
    // A fork's inherited prompts are not its own recency, so a fresh fork has no
    // latestUserMessageAt; it still holds a conversation.
    const fork = thread({ latestUserMessageAt: null, lineage: { relationship: "forked" } });
    expect(ids(fork)).toEqual(["archive", "delete"]);
    expect(
      ids(thread({ latestUserMessageAt: null, lineage: { relationship: "delegated" } })),
    ).toEqual(["delete"]);
  });

  it("never offers a misleading close: Delete is the only removal and is destructive", () => {
    const items = listThreadLifecycleActions(thread({ session: { status: "ready" } }));
    expect(items.map((action) => action.label)).toEqual([
      "Stop session",
      "Archive thread",
      "Delete…",
    ]);
    expect(items.some((action) => /close|trash/i.test(action.label))).toBe(false);
    expect(items.find((action) => action.id === "delete")?.destructive).toBe(true);
  });

  it("holds archiving only while the session runs a turn", () => {
    expect(
      isThreadArchiveBlockedByTurn(
        thread({ session: { status: "running", activeTurnId: "turn" } }),
      ),
    ).toBe(true);
    expect(isThreadArchiveBlockedByTurn(thread({ session: { status: "running" } }))).toBe(false);
    expect(isThreadArchiveBlockedByTurn(thread({ latestTurn: { state: "running" } }))).toBe(false);
    expect(isThreadArchiveBlockedByTurn(thread())).toBe(false);
  });
});

describe("workspace lifecycle actions", () => {
  const actions = (subject: Parameters<typeof listWorkspaceLifecycleActions>[0]) =>
    listWorkspaceLifecycleActions(subject, { protectedWorkspace: false }).map((item) => [
      item.action,
      item.review,
    ]);

  it("offers Archive or Restore, then a reviewed Delete", () => {
    expect(actions({ archivedAt: null })).toEqual([
      ["archive", false],
      ["delete-workspace", true],
    ]);
    expect(actions({ archivedAt: "2026-10-01T00:00:00.000Z" })).toEqual([
      ["restore", false],
      ["delete-workspace", true],
    ]);
    // A removed or missing checkout restores (the node recreates it).
    expect(actions({ archivedAt: null, checkoutRemovedAt: "2026-10-01T00:00:00.000Z" })).toEqual([
      ["restore", false],
      ["delete-workspace", true],
    ]);
    expect(actions({ archivedAt: null, checkout: "missing" })).toEqual([
      ["restore", false],
      ["delete-workspace", true],
    ]);
  });

  it("never offers the checkout-only actions", () => {
    const offered = [
      { archivedAt: null },
      { archivedAt: "2026-10-01T00:00:00.000Z" },
      { archivedAt: "2026-10-01T00:00:00.000Z", checkoutRemovedAt: "2026-10-01T00:00:00.000Z" },
    ].flatMap((subject) => actions(subject).map(([action]) => action));
    expect(offered).not.toContain("remove-checkout");
    expect(offered).not.toContain("remove-stale-record");
    expect(offered).not.toContain("recreate-checkout");
    expect(
      listWorkspaceLifecycleActions({ archivedAt: null }, { protectedWorkspace: false }).map(
        (item) => item.label,
      ),
    ).toEqual(["Archive workspace", "Delete workspace…"]);
  });

  it("offers nothing for the project root/main checkout or a deleted workspace", () => {
    expect(
      listWorkspaceLifecycleActions({ archivedAt: null }, { protectedWorkspace: true }),
    ).toEqual([]);
    expect(
      actions({
        archivedAt: "2026-10-01T00:00:00.000Z",
        checkoutRemovedAt: "2026-10-01T00:00:00.000Z",
        checkoutRemovalReason: "deleted",
      }),
    ).toEqual([]);
  });

  it("recognizes deleted workspaces", () => {
    expect(isWorkspaceDeleted({ checkoutRemovalReason: "deleted" })).toBe(true);
    expect(isWorkspaceDeleted({ checkoutRemovalReason: "removed" })).toBe(false);
    expect(isWorkspaceDeleted({ checkoutRemovalReason: null })).toBe(false);
    expect(isWorkspaceDeleted({})).toBe(false);
  });
});

describe("workspace review classification", () => {
  it("reviews only Delete", () => {
    expect(
      (["archive", "restore", "delete-workspace"] as const).filter(isWorkspaceReviewAction),
    ).toEqual(["delete-workspace"]);
    expect(WORKSPACE_REVIEW_ACTIONS).toEqual(["delete-workspace"]);
  });

  it("opens old removal links as the delete review and drops recreate links", () => {
    expect(parseWorkspaceReviewAction("delete-workspace")).toBe("delete-workspace");
    expect(parseWorkspaceReviewAction("remove-checkout")).toBe("delete-workspace");
    expect(parseWorkspaceReviewAction("remove-stale-record")).toBe("delete-workspace");
    expect(parseWorkspaceReviewAction("recreate-checkout")).toBeNull();
    expect(parseWorkspaceReviewAction(undefined)).toBeNull();
  });

  it("deletes a workspace with a discarding removal that always deletes the branch", () => {
    expect(workspaceActionRequest("delete-workspace")).toEqual({
      action: "remove-checkout",
      discard: true,
      deleteBranch: true,
      deleteConversations: false,
    });
    expect(workspaceActionRequest("delete-workspace", { deleteConversations: true })).toEqual({
      action: "remove-checkout",
      discard: true,
      deleteBranch: true,
      deleteConversations: true,
    });
    expect(workspaceActionRequest("archive")).toEqual({ action: "archive", discard: false });
  });
});
