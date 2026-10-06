import { describe, expect, it } from "vite-plus/test";

import type { SidebarTreeThread, SidebarTreeWorktree } from "./useSidebarTree";
import { resolveWorktreeOpenTarget } from "./useSidebarWorktreeActions";

const thread = (id: string, updatedAt: string) =>
  ({ id, environmentId: "env", createdAt: updatedAt, updatedAt }) as unknown as SidebarTreeThread;

function node(input: {
  readonly sessions?: SidebarTreeThread[];
  readonly archivedSessions?: SidebarTreeThread[];
  readonly archivedAt?: string | null;
  readonly checkoutRemovedAt?: string | null;
}): Pick<SidebarTreeWorktree, "sessions" | "archivedSessions" | "worktree"> {
  return {
    sessions: input.sessions ?? [],
    archivedSessions: input.archivedSessions ?? [],
    worktree: {
      worktreeId: "wt",
      projectId: "p",
      branch: "feature",
      worktreePath: "/w",
      origin: "branch",
      archivedAt: input.archivedAt ?? null,
      checkoutRemovedAt: input.checkoutRemovedAt ?? null,
    },
  };
}

describe("resolveWorktreeOpenTarget", () => {
  it("opens the latest active thread", () => {
    const target = resolveWorktreeOpenTarget(
      node({
        sessions: [
          thread("old", "2026-10-01T00:00:00.000Z"),
          thread("new", "2026-10-02T00:00:00.000Z"),
        ],
      }),
    );
    expect(target).toMatchObject({ kind: "thread", thread: { id: "new" } });
  });

  it("starts a thread only in a live workspace", () => {
    expect(resolveWorktreeOpenTarget(node({}))).toEqual({ kind: "new-thread" });
  });

  it("never starts a thread in an archived workspace or a removed checkout", () => {
    const archived = thread("archived", "2026-09-01T00:00:00.000Z");
    expect(
      resolveWorktreeOpenTarget(
        node({ checkoutRemovedAt: "2026-10-01T00:00:00.000Z", archivedSessions: [archived] }),
      ),
    ).toMatchObject({ kind: "thread", thread: { id: "archived" } });
    expect(resolveWorktreeOpenTarget(node({ archivedAt: "2026-10-01T00:00:00.000Z" }))).toEqual({
      kind: "none",
    });
    expect(
      resolveWorktreeOpenTarget(node({ checkoutRemovedAt: "2026-10-01T00:00:00.000Z" })),
    ).toEqual({ kind: "none" });
  });
});
