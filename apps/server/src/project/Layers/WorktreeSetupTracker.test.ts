import { ThreadId, type WorktreeSetupSnapshot } from "@ryco/contracts";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { makeWorktreeSetupTracker } from "./WorktreeSetupTracker.ts";

const threadId = ThreadId.make("thread-setup");

const stageStatuses = (snapshot: WorktreeSetupSnapshot) =>
  Object.fromEntries(snapshot.stages.map((stage) => [stage.id, stage.status]));

describe("WorktreeSetupTracker", () => {
  it("lists every stage up front and skips the fetch when nothing is fetched", async () => {
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const tracker = yield* makeWorktreeSetupTracker;
        yield* tracker.begin({ threadId, baseRef: "main", branch: "ryco/1", fetchOrigin: false });
        return yield* tracker.stream(threadId).pipe(Stream.take(1), Stream.runHead);
      }),
    );
    expect(snapshot._tag).toBe("Some");
    if (snapshot._tag !== "Some") return;
    expect(stageStatuses(snapshot.value)).toEqual({
      fetch: "skipped",
      checkout: "pending",
      "setup-script": "pending",
      agent: "pending",
    });
    expect(snapshot.value.branch).toBe("ryco/1");
    expect(snapshot.value.status).toBe("running");
  });

  it("delivers a setup that begins after the subscriber arrived, then each change in order", async () => {
    const snapshots = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* makeWorktreeSetupTracker;
          const collected = yield* tracker
            .stream(threadId)
            .pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped);
          // Let the subscriber attach before anything is published.
          yield* Effect.yieldNow;
          const handle = yield* tracker.begin({
            threadId,
            baseRef: "origin/main",
            fetchOrigin: true,
          });
          yield* handle.stage("fetch", { status: "running" });
          yield* handle.stage("fetch", { status: "done", detail: "prefetched" });
          yield* handle.stage("checkout", { status: "running", percent: 41.6 });
          // Rounds to the published value: not a change, so not delivered.
          yield* handle.stage("checkout", { percent: 42 });
          yield* handle.stage("checkout", { percent: 80 });
          return yield* Fiber.join(collected);
        }),
      ),
    );
    // `begin` itself publishes nothing: the first delivery is the fetch starting.
    expect(snapshots.map((snapshot) => stageStatuses(snapshot).fetch)).toEqual([
      "running",
      "done",
      "done",
      "done",
    ]);
    expect(snapshots[1]?.stages[0]?.detail).toBe("prefetched");
    expect(snapshots[2]?.stages[1]).toMatchObject({ status: "running", percent: 42 });
    expect(snapshots[3]?.stages[1]).toMatchObject({ status: "running", percent: 80 });
    const sequences = snapshots.map((snapshot) => snapshot.sequence);
    expect(sequences.toSorted((a, b) => a - b)).toEqual(sequences);
    expect(new Set(sequences).size).toBe(sequences.length);
  }, 10_000);

  it("keeps the output tail readable and strips terminal escapes", async () => {
    const tail = await Effect.runPromise(
      Effect.gen(function* () {
        const tracker = yield* makeWorktreeSetupTracker;
        const handle = yield* tracker.begin({ threadId, baseRef: "main", fetchOrigin: false });
        yield* handle.appendOutput("\u001b[32m$ bun install\u001b[0m\r\n");
        yield* handle.appendOutput("Resolving 10%\rResolving 100%\r\n");
        yield* handle.appendOutput("line a\nline b\nline c\n");
        return (yield* tracker.stream(threadId).pipe(Stream.runHead)).pipe((option) =>
          option._tag === "Some" ? option.value.outputTail : [],
        );
      }),
    );
    expect(tail).toEqual(["Resolving 100%", "line a", "line b", "line c"]);
  });

  it("does not replay a failed setup to the retry that waits for the next one", async () => {
    const snapshots = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* makeWorktreeSetupTracker;
          const failed = yield* tracker.begin({ threadId, baseRef: "main", fetchOrigin: true });
          yield* failed.stage("fetch", { status: "running" });
          yield* failed.finish("failed", "fatal: unreachable origin");
          yield* failed.release;
          const collected = yield* tracker
            .stream(threadId)
            .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
          yield* Effect.yieldNow;
          const retry = yield* tracker.begin({ threadId, baseRef: "main", fetchOrigin: true });
          yield* retry.stage("fetch", { status: "running" });
          return yield* Fiber.join(collected);
        }),
      ),
    );
    expect(snapshots.map((snapshot) => snapshot.status)).toEqual(["running"]);
    expect(stageStatuses(snapshots[0]!).fetch).toBe("running");
  });

  it("honours a cancel only before the setup turns uncancellable", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const tracker = yield* makeWorktreeSetupTracker;
        const handle = yield* tracker.begin({ threadId, baseRef: "main", fetchOrigin: false });
        const accepted = yield* tracker.cancel(threadId);
        const requested = yield* handle.cancelRequested;
        const markedAfterCancel = yield* handle.markUncancellable;

        const other = ThreadId.make("thread-other");
        const otherHandle = yield* tracker.begin({
          threadId: other,
          baseRef: "main",
          fetchOrigin: false,
        });
        const marked = yield* otherHandle.markUncancellable;
        const lateCancel = yield* tracker.cancel(other);
        const unknownCancel = yield* tracker.cancel(ThreadId.make("thread-unknown"));
        return { accepted, requested, markedAfterCancel, marked, lateCancel, unknownCancel };
      }),
    );
    expect(result).toEqual({
      accepted: true,
      requested: true,
      markedAfterCancel: false,
      marked: true,
      lateCancel: false,
      unknownCancel: false,
    });
  });

  it("turns a failed setup's running stage into the failed one and keeps the error", async () => {
    const snapshots = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* makeWorktreeSetupTracker;
          const handle = yield* tracker.begin({ threadId, baseRef: "main", fetchOrigin: false });
          yield* handle.stage("checkout", { status: "running", percent: 62 });
          const collected = yield* tracker.stream(threadId).pipe(
            Stream.takeUntil((snapshot) => snapshot.status !== "running"),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          yield* handle.finish("failed", "fatal: could not lock ref");
          return yield* Fiber.join(collected);
        }),
      ),
    );
    const failed = snapshots.at(-1)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("fatal: could not lock ref");
    expect(stageStatuses(failed).checkout).toBe("failed");
    expect(stageStatuses(failed)["setup-script"]).toBe("pending");
  });
});
