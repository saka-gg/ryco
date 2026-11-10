import {
  OrchestrationShellSnapshot,
  ProjectId,
  ThreadId,
  WorktreeId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import { Deferred, Effect, Option, Schema } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeShellSnapshotCopy } from "./shellSnapshotCopy.ts";
import type { ThreadBackgroundLiveness } from "./ThreadBackgroundLiveness.ts";

const time = (second: number) => `2026-10-04T00:00:${String(second).padStart(2, "0")}.000Z`;

const thread = (
  id: string,
  createdSecond: number,
  updatedSecond = createdSecond,
  extra: Record<string, unknown> = {},
) => ({
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
  archivedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...extra,
});

const decodeShell = Schema.decodeUnknownSync(OrchestrationShellSnapshot);

/** A database stand-in: rows by id, and a whole-shell build over them. */
function harness(options: { readonly liveness?: Map<string, ThreadBackgroundLiveness> } = {}) {
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
  const extraWorktrees: Array<Record<string, unknown>> = [];
  /** The database's sequence: what a build sees. */
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
      worktrees: [{ ...worktree, title: worktreeTitle }, ...extraWorktrees].toSorted(
        (x, y) =>
          (x.manualPosition as number) - (y.manualPosition as number) ||
          String(x.worktreeId).localeCompare(String(y.worktreeId)),
      ),
      threads: [...threads.values()].toSorted((x, y) => x.createdAt.localeCompare(y.createdAt)),
    });
  const buildShell = vi.fn(() => Effect.succeed(build()));
  const getThreadShellById = vi.fn((threadId: ThreadId) =>
    Effect.succeed(
      Option.fromNullishOr(build().threads.find((row) => row.id === threadId) ?? null),
    ),
  );
  let now = Date.parse(time(0));
  const copy = makeShellSnapshotCopy(
    {
      buildShell,
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
    },
    {
      now: () => now,
      fullRefreshMs: 60_000,
      ...(options.liveness === undefined
        ? {}
        : {
            liveness: {
              get: (threadId: string) => options.liveness!.get(threadId) ?? null,
              liveThreadIds: () => [...options.liveness!.keys()],
            },
          }),
    },
  );
  /** Commits an event (the database moves) and records it, as the engine does. */
  const event = (type: string, aggregateKind: string, aggregateId: string, payload: object) => {
    sequence += 1;
    copy.record([
      { type, aggregateKind, aggregateId, payload, sequence } as unknown as OrchestrationEvent,
    ]);
  };
  return {
    threads,
    copy,
    build,
    buildShell,
    getThreadShellById,
    event,
    commitUnrecorded: () => (sequence += 1),
    sequence: () => sequence,
    setWorktreeTitle: (title: string) => (worktreeTitle = title),
    worktree,
    extraWorktrees,
    advance: (ms: number) => (now += ms),
    read: () => Effect.runPromise(copy.read()),
    readThread: (id: string) => Effect.runPromise(copy.readThread(ThreadId.make(id))),
  };
}

const ids = (threads: ReadonlyArray<OrchestrationThreadShell>) => threads.map((row) => row.id);

describe("shell snapshot copy", () => {
  it("patches changed threads instead of rebuilding, matching a full build", async () => {
    const h = harness();
    expect(ids((await h.read()).threads)).toEqual(["a", "b"]);
    expect(h.copy.stats().fullBuilds).toBe(1);

    // An update keeps its place, a new thread takes the query's order, a deleted one leaves.
    h.threads.set("a", thread("a", 1, 9));
    h.event("thread.activity-appended", "thread", "a", { threadId: "a" });
    h.threads.set("c", thread("c", 0));
    h.event("thread.created", "thread", "c", { threadId: "c" });
    h.threads.delete("b");
    h.event("thread.deleted", "thread", "b", { threadId: "b" });
    const patched = await h.read();
    expect(h.copy.stats().fullBuilds).toBe(1);
    expect(h.getThreadShellById).toHaveBeenCalledTimes(3);
    const full = h.build();
    expect({ ...patched, updatedAt: "" }).toEqual({ ...full, updatedAt: "" });
    expect(patched.updatedAt).toBe(time(9));
  });

  it("serves the sequence of the last recorded event, never one a row may not reflect", async () => {
    const h = harness();
    expect((await h.read()).snapshotSequence).toBe(1);
    // Committed but not recorded yet (between the commit and the engine's publish).
    h.commitUnrecorded();
    expect((await h.read()).snapshotSequence).toBe(1);
    h.event("thread.meta-updated", "thread", "a", { threadId: "a" });
    expect((await h.read()).snapshotSequence).toBe(3);
  });

  it("skips events a build already reflects", async () => {
    const h = harness();
    // Two events commit before the first build; their publication follows it.
    const late = [h.commitUnrecorded(), h.commitUnrecorded()];
    await h.read();
    h.copy.record(
      late.map(
        (sequence) =>
          ({
            type: "thread.meta-updated",
            aggregateKind: "thread",
            aggregateId: "a",
            payload: { threadId: "a" },
            sequence,
          }) as unknown as OrchestrationEvent,
      ),
    );
    await h.read();
    expect(h.getThreadShellById).not.toHaveBeenCalled();
    expect(h.copy.stats().patches).toBe(0);
  });

  it("answers a settled row without reading and shares one read among concurrent readers", async () => {
    const h = harness();
    await h.read();
    await h.readThread("a");
    expect(h.getThreadShellById).not.toHaveBeenCalled();

    h.threads.set("a", thread("a", 1, 7));
    h.event("thread.activity-appended", "thread", "a", { threadId: "a" });
    const rows = await Promise.all(Array.from({ length: 5 }, () => h.readThread("a")));
    expect(h.getThreadShellById).toHaveBeenCalledTimes(1);
    // The same row object for every reader.
    const first = Option.getOrThrow(rows[0]!);
    expect(first.updatedAt).toBe(time(7));
    for (const row of rows) expect(Option.getOrThrow(row)).toBe(first);
    expect(Option.isNone(await h.readThread("missing"))).toBe(true);
  });

  it("does not serve a row a refresh in flight is re-reading", async () => {
    const h = harness();
    await h.read();
    const gate = Effect.runSync(Deferred.make<void>());
    const reading = Effect.runSync(Deferred.make<void>());
    h.threads.set("a", thread("a", 1, 8));
    h.getThreadShellById.mockImplementationOnce((threadId: ThreadId) =>
      Deferred.succeed(reading, undefined).pipe(
        Effect.andThen(Deferred.await(gate)),
        Effect.as(Option.fromNullishOr(h.build().threads.find((row) => row.id === threadId))),
      ),
    );
    h.event("thread.activity-appended", "thread", "a", { threadId: "a" });
    const pending = h.readThread("a");
    // The refresh has taken the change and is reading the row.
    await Effect.runPromise(Deferred.await(reading));
    const second = h.readThread("a");
    Effect.runSync(Deferred.succeed(gate, undefined));
    expect(Option.getOrThrow(await pending).updatedAt).toBe(time(8));
    expect(Option.getOrThrow(await second).updatedAt).toBe(time(8));
  });

  it("patches workspace rows", async () => {
    const h = harness();
    await h.read();
    h.setWorktreeTitle("Renamed");
    h.event("worktree.metaUpdated", "worktree", "worktree-1", { worktreeId: "worktree-1" });
    expect((await h.read()).worktrees?.[0]?.title).toBe("Renamed");
    expect(h.copy.stats().fullBuilds).toBe(1);
  });

  it("rebuilds for unmodeled events, on the refresh interval and after a failure", async () => {
    const h = harness();
    await h.read();
    h.event("project.deleted", "project", "project-1", { projectId: "project-1" });
    await h.read();
    expect(h.copy.stats().fullBuilds).toBe(2);

    h.advance(60_000);
    await h.read();
    expect(h.copy.stats().fullBuilds).toBe(3);

    h.getThreadShellById.mockImplementationOnce(() => Effect.fail("database is locked" as never));
    h.event("thread.meta-updated", "thread", "a", { threadId: "a" });
    await expect(h.read()).rejects.toBeDefined();
    await h.read();
    expect(h.copy.stats().fullBuilds).toBe(4);
  });

  it("fails a read whose build fails instead of retrying forever", async () => {
    const h = harness();
    h.buildShell.mockImplementation(() => Effect.fail("disk I/O error" as never));
    await expect(h.read()).rejects.toBeDefined();
    expect(h.buildShell).toHaveBeenCalledTimes(1);
  });

  it("serves the current background liveness and drops expired ended pull request watches", async () => {
    const liveness = new Map<string, ThreadBackgroundLiveness>();
    const h = harness({ liveness });
    const watches = {
      active: [],
      ended: [{ watchId: "github.com/o/r#9", number: 9, reason: "merged", endedAt: time(0) }],
    };
    h.threads.set("b", thread("b", 2, 2, { pullRequestWatches: watches }));
    const first = await h.read();
    expect(first.threads[1]!.pullRequestWatches).toEqual(watches);

    // No event reports either change.
    liveness.set("a", "working");
    h.advance(24 * 3_600_000);
    const served = await h.read();
    expect(served.threads[0]!.backgroundLiveness).toBe("working");
    expect(served.threads[1]!.pullRequestWatches).toBeUndefined();
    expect(Option.getOrThrow(await h.readThread("a")).backgroundLiveness).toBe("working");

    liveness.delete("a");
    expect((await h.read()).threads[0]!.backgroundLiveness).toBeNull();
  });

  it("stubs archived threads once per served snapshot", async () => {
    const h = harness();
    h.threads.set("b", thread("b", 2, 2, { archivedAt: time(3) }));
    const stubbed = await Effect.runPromise(h.copy.readStubbed());
    expect(ids(stubbed.threads)).toEqual(["a"]);
    expect(stubbed.archivedThreadStubs?.map((stub) => stub.id)).toEqual(["b"]);
    expect(await Effect.runPromise(h.copy.readStubbed())).toBe(stubbed);
  });
  it("answers what changed since a sequence from its change index", async () => {
    const h = harness();
    const changes = (sequence: number) =>
      Effect.runPromise(h.copy.changesSince(sequence)).then(Option.getOrUndefined);
    // Not started: nothing can be answered.
    expect(await changes(1)).toBeUndefined();
    h.copy.startChangeIndex(h.sequence());
    await h.read();
    const start = h.sequence();

    h.threads.set("a", thread("a", 1, 7));
    h.event("thread.activity-appended", "thread", "a", { threadId: "a" });
    h.setWorktreeTitle("Renamed");
    h.event("worktree.metaUpdated", "worktree", "worktree-1", { worktreeId: "worktree-1" });
    h.threads.delete("b");
    h.event("thread.deleted", "thread", "b", { threadId: "b" });
    h.threads.set("a", thread("a", 1, 8));
    h.event("thread.meta-updated", "thread", "a", { threadId: "a" });

    const all = await changes(start);
    expect(all?.snapshotSequence).toBe(h.sequence());
    expect(all?.threadCount).toBe(2);
    expect(all?.liveThreadCount).toBe(1);
    expect(all?.items.map((item) => [item.kind, item.sequence])).toEqual([
      ["worktree-upserted", start + 2],
      ["thread-removed", start + 3],
      ["thread-upserted", start + 4],
    ]);
    const upsert = all?.items[2];
    expect(upsert?.kind === "thread-upserted" ? upsert.thread.updatedAt : null).toBe(time(8));

    // From a later position only what changed after it.
    expect((await changes(start + 3))?.items.map((item) => item.kind)).toEqual(["thread-upserted"]);
    expect((await changes(h.sequence()))?.items).toEqual([]);
    // Positions before the index or after the copy cannot be answered.
    expect(await changes(start - 1)).toBeUndefined();
    expect(await changes(h.sequence() + 5)).toBeUndefined();
  });

  it("starts its change index over after an event it cannot attribute to rows", async () => {
    const h = harness();
    h.copy.startChangeIndex(h.sequence());
    await h.read();
    const start = h.sequence();
    h.event("thread.meta-updated", "thread", "a", { threadId: "a" });
    h.event("worktree.relocated", "worktree", "worktree-1", { worktreeId: "worktree-1" });
    const relocatedAt = h.sequence();
    expect(Option.isNone(await Effect.runPromise(h.copy.changesSince(start)))).toBe(true);
    const after = await Effect.runPromise(h.copy.changesSince(relocatedAt));
    expect(Option.getOrThrow(after).items).toEqual([]);
  });
  it("keeps the query's workspace order after a manual reorder", async () => {
    const h = harness();
    h.extraWorktrees.push({ ...h.worktree, worktreeId: "worktree-2", manualPosition: 1 });
    expect((await h.read()).worktrees?.map((row) => row.worktreeId)).toEqual([
      "worktree-1",
      "worktree-2",
    ]);
    h.extraWorktrees[0]!.manualPosition = -1;
    h.event("worktree.manualPositionSet", "worktree", "worktree-2", { worktreeId: "worktree-2" });
    const patched = await h.read();
    expect(h.copy.stats().fullBuilds).toBe(1);
    expect(patched.worktrees).toEqual(h.build().worktrees);
  });

  it("answers changes only up to what it recorded, when a build saw more", async () => {
    const h = harness();
    h.copy.startChangeIndex(h.sequence());
    await h.read();
    const start = h.sequence();
    h.threads.set("a", thread("a", 1, 9));
    // Committed, not yet recorded: a rebuild sees it.
    const unrecorded = h.commitUnrecorded();
    h.copy.invalidate();
    const changes = Option.getOrThrow(await Effect.runPromise(h.copy.changesSince(start)));
    // The change is left to the event-log replay after the answer's sequence.
    expect(changes.snapshotSequence).toBe(start);
    expect(changes.snapshotSequence).toBeLessThan(unrecorded);
    expect(changes.items).toEqual([]);
  });

  it("reports a removed thread even when an event after the answer names it again", async () => {
    const h = harness();
    h.copy.startChangeIndex(h.sequence());
    await h.read();
    const start = h.sequence();
    h.threads.delete("b");
    h.event("thread.deleted", "thread", "b", { threadId: "b" });
    await h.read();
    // Recorded after the copy served its sequence: outside the answer's range.
    h.copy.record([
      {
        type: "thread.meta-updated",
        aggregateKind: "thread",
        aggregateId: "b",
        payload: { threadId: "b" },
        sequence: h.sequence() + 1,
      } as unknown as OrchestrationEvent,
    ]);
    const changes = await Effect.runPromise(
      Effect.flatMap(h.copy.read(), () => h.copy.changesSince(start)),
    );
    expect(Option.getOrThrow(changes).items.map((item) => item.kind)).toContain("thread-removed");
  });
});
