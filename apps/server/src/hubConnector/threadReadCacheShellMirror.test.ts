import {
  OrchestrationShellSnapshot,
  ProjectId,
  ThreadId,
  WorktreeId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadReadCacheShellMirror } from "./threadReadCacheShellMirror.ts";

const time = (second: number) => `2026-10-04T00:00:${String(second).padStart(2, "0")}.000Z`;

const thread = (id: string, createdSecond: number, updatedSecond = createdSecond) =>
  ({
    id,
    projectId: "project-1",
    title: `Thread ${id}`,
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: time(createdSecond),
    updatedAt: time(updatedSecond),
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }) as const;

const decodeShell = Schema.decodeUnknownSync(OrchestrationShellSnapshot);

/** A database stand-in: rows by id, and a whole-shell build over them. */
function harness() {
  const threads = new Map<string, ReturnType<typeof thread>>([
    ["b", thread("b", 2)],
    ["a", thread("a", 1)],
  ]);
  const worktree = {
    worktreeId: "worktree-1",
    projectId: "project-1",
    title: null,
    branch: "main",
    worktreePath: null,
    origin: "main",
    prNumber: null,
    issueNumber: null,
    prTitle: null,
    issueTitle: null,
    createdAt: time(0),
    updatedAt: time(0),
    archivedAt: null,
    manualPosition: 0,
  };
  let worktreeTitle: string | null = null;
  let sequence = 1;
  const project = {
    id: "project-1",
    title: "Project",
    workspaceRoot: "/tmp/project-1",
    defaultModelSelection: null,
    scripts: [],
    createdAt: time(0),
    updatedAt: time(0),
  };
  const build = () =>
    decodeShell({
      snapshotSequence: sequence,
      updatedAt: time(0),
      projects: [project],
      worktrees: [{ ...worktree, title: worktreeTitle }],
      threads: [...threads.values()].toSorted((x, y) => x.createdAt.localeCompare(y.createdAt)),
    });
  const getShellSnapshot = vi.fn(() => Effect.succeed(build()));
  const getThreadShellById = vi.fn((threadId: ThreadId) =>
    Effect.succeed(
      Option.fromNullishOr(build().threads.find((row) => row.id === threadId) ?? null),
    ),
  );
  const query = {
    getShellSnapshot,
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: sequence }),
    getThreadShellById,
    getProjectShellById: (projectId: ProjectId) =>
      Effect.succeed(
        Option.fromNullishOr(build().projects.find((p) => p.id === projectId) ?? null),
      ),
    getWorktreeShellById: (worktreeId: WorktreeId) =>
      Effect.succeed(
        Option.fromNullishOr(
          build().worktrees?.find((row) => row.worktreeId === worktreeId) ?? null,
        ),
      ),
  };
  let now = 0;
  const mirror = makeThreadReadCacheShellMirror(query, { now: () => now, fullRefreshMs: 60_000 });
  const event = (type: string, aggregateKind: string, aggregateId: string, payload: object) => {
    sequence += 1;
    mirror.record({
      type,
      aggregateKind,
      aggregateId,
      payload,
      sequence,
    } as unknown as OrchestrationEvent);
  };
  return {
    threads,
    mirror,
    build,
    getShellSnapshot,
    getThreadShellById,
    event,
    setWorktreeTitle: (title: string) => (worktreeTitle = title),
    advance: (ms: number) => (now += ms),
    read: () => Effect.runPromise(mirror.read()),
  };
}

const ids = (threads: ReadonlyArray<OrchestrationThreadShell>) => threads.map((row) => row.id);

describe("thread read cache shell mirror", () => {
  it("patches changed threads instead of rebuilding, matching a full build", async () => {
    const h = harness();
    expect(ids((await h.read()).threads)).toEqual(["a", "b"]);
    expect(h.mirror.fullBuilds()).toBe(1);

    // An update keeps its place, a new thread takes the query's order, a trashed one leaves.
    h.threads.set("a", thread("a", 1, 9));
    h.event("thread.activity-appended", "thread", "a", { threadId: "a" });
    h.threads.set("c", thread("c", 0));
    h.event("thread.created", "thread", "c", { threadId: "c" });
    h.threads.delete("b");
    h.event("thread.trashed", "thread", "b", { threadId: "b" });
    const patched = await h.read();
    expect(h.mirror.fullBuilds()).toBe(1);
    expect(h.getThreadShellById).toHaveBeenCalledTimes(3);
    const full = h.build();
    expect({ ...patched, updatedAt: "" }).toEqual({ ...full, updatedAt: "" });
    expect(patched.updatedAt).toBe(time(9));
  });

  it("patches workspace rows and follows the sequence of events it does not model", async () => {
    const h = harness();
    await h.read();
    h.setWorktreeTitle("Renamed");
    h.event("worktree.metaUpdated", "worktree", "worktree-1", { worktreeId: "worktree-1" });
    expect((await h.read()).worktrees?.[0]?.title).toBe("Renamed");
    expect(h.mirror.fullBuilds()).toBe(1);
  });

  it("rebuilds for unmodeled events, on the refresh interval and after a failure", async () => {
    const h = harness();
    await h.read();
    h.event("project.deleted", "project", "project-1", { projectId: "project-1" });
    await h.read();
    expect(h.mirror.fullBuilds()).toBe(2);

    h.advance(60_000);
    await h.read();
    expect(h.mirror.fullBuilds()).toBe(3);

    h.getThreadShellById.mockImplementationOnce(() => Effect.fail("database is locked" as never));
    h.event("thread.meta-updated", "thread", "a", { threadId: "a" });
    await expect(h.read()).rejects.toBeDefined();
    await h.read();
    expect(h.mirror.fullBuilds()).toBe(4);
  });

  it("only advances the sequence when no row changed", async () => {
    const h = harness();
    const first = await h.read();
    h.mirror.record({
      type: "thread.activity-appended",
      aggregateKind: "thread",
      aggregateId: ThreadId.make("a"),
      sequence: 2,
    } as unknown as OrchestrationEvent);
    await h.read();
    expect(h.mirror.fullBuilds()).toBe(1);
    expect(first.snapshotSequence).toBe(1);
  });
});
