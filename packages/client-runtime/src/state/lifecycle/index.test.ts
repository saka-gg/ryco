import { describe, expect, it } from "vite-plus/test";

import {
  listThreadLifecycleActions,
  listWorkspaceLifecycleActions,
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
  it("separates interrupt, stop, archive and trash", () => {
    expect(ids(thread({ session: { status: "running", activeTurnId: "turn" } }))).toEqual([
      "interrupt-turn",
      "archive",
      "trash",
    ]);
    expect(ids(thread({ session: { status: "ready", activeTurnId: null } }))).toEqual([
      "stop-session",
      "archive",
      "trash",
    ]);
    expect(ids(thread({ session: { status: "stopped" } }))).toEqual(["archive", "trash"]);
    expect(ids(thread({ archivedAt: "2026-10-01T00:00:00.000Z" }))).toEqual(["unarchive", "trash"]);
    // A never-used thread cannot be archived, but it can still go to Trash.
    expect(ids(thread({ latestUserMessageAt: null }))).toEqual(["trash"]);
  });

  it("never offers deletion or a misleading close: Trash is the only removal", () => {
    const labels = listThreadLifecycleActions(thread({ session: { status: "ready" } })).map(
      (action) => action.label,
    );
    expect(labels).toEqual(["Stop session", "Archive thread", "Move to Trash"]);
    expect(labels.some((label) => /close|delete/i.test(label))).toBe(false);
  });
});

describe("workspace lifecycle actions", () => {
  const actions = (archivedAt: string | null, checkoutRemovedAt: string | null = null) =>
    listWorkspaceLifecycleActions(
      { archivedAt, checkoutRemovedAt },
      { protectedWorkspace: false },
    ).map((item) => [item.action, item.review]);

  it("archives without review and reviews anything touching a checkout", () => {
    expect(actions(null)).toEqual([
      ["archive", false],
      ["remove-checkout", true],
    ]);
    expect(actions("2026-10-01T00:00:00.000Z")).toEqual([
      ["restore", false],
      ["remove-checkout", true],
    ]);
    expect(actions("2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z")).toEqual([
      ["restore", false],
      ["recreate-checkout", true],
    ]);
  });

  it("offers nothing for the project root/main checkout", () => {
    expect(
      listWorkspaceLifecycleActions({ archivedAt: null }, { protectedWorkspace: true }),
    ).toEqual([]);
  });
});
