import {
  type ThreadId,
  WORKTREE_SETUP_STAGE_IDS,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStage,
} from "@ryco/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";

import {
  type WorktreeSetupHandle,
  WorktreeSetupTracker,
  type WorktreeSetupTrackerShape,
} from "../Services/WorktreeSetupTracker.ts";
import { TerminalOutputTail } from "../worktreeSetupOutputTail.ts";

/** How long a released setup stays readable for a late or reconnecting subscriber. */
export const WORKTREE_SETUP_RETENTION_MS = 30_000;
const CHANNEL_CAPACITY = 256;

interface SetupEntry {
  snapshot: WorktreeSetupSnapshot;
  readonly tail: TerminalOutputTail;
  cancelRequested: boolean;
  cancellable: boolean;
  releasedAtMs: number | null;
}

const isSettled = (status: WorktreeSetupStage["status"]) =>
  status === "done" || status === "skipped" || status === "failed";

export const makeWorktreeSetupTracker = Effect.gen(function* () {
  const entries = new Map<ThreadId, SetupEntry>();
  const changes = yield* PubSub.sliding<WorktreeSetupSnapshot>(CHANNEL_CAPACITY);
  // One counter for every setup, so a replacement setup of the same thread
  // still reads as newer to a subscriber that saw the previous one.
  let sequence = 0;

  const sweep = (nowMs: number) => {
    for (const [threadId, entry] of entries) {
      if (entry.releasedAtMs !== null && nowMs - entry.releasedAtMs > WORKTREE_SETUP_RETENTION_MS) {
        entries.delete(threadId);
      }
    }
  };

  const publish = (
    entry: SetupEntry,
    change: (snapshot: WorktreeSetupSnapshot) => WorktreeSetupSnapshot,
  ) =>
    Effect.suspend(() => {
      // A setup replaced by a newer one of the same thread (a retry) keeps
      // its handle, but no longer speaks for the thread.
      if (entries.get(entry.snapshot.threadId) !== entry) return Effect.void;
      const next = change(entry.snapshot);
      if (next === entry.snapshot) return Effect.void;
      sequence += 1;
      entry.snapshot = { ...next, sequence, updatedAt: new Date().toISOString() };
      return PubSub.publish(changes, entry.snapshot).pipe(Effect.asVoid);
    });

  const begin: WorktreeSetupTrackerShape["begin"] = (input) =>
    Effect.suspend(() => {
      const nowMs = Date.now();
      sweep(nowMs);
      const startedAt = new Date(nowMs).toISOString();
      sequence += 1;
      const stages: WorktreeSetupStage[] = WORKTREE_SETUP_STAGE_IDS.map((id) => ({
        id,
        status: id === "fetch" && !input.fetchOrigin ? "skipped" : "pending",
      }));
      const entry: SetupEntry = {
        snapshot: {
          threadId: input.threadId,
          sequence,
          status: "running",
          baseRef: input.baseRef,
          ...(input.branch ? { branch: input.branch } : {}),
          stages,
          outputTail: [],
          startedAt,
          updatedAt: startedAt,
        },
        tail: new TerminalOutputTail(),
        cancelRequested: false,
        cancellable: true,
        releasedAtMs: null,
      };
      entries.set(input.threadId, entry);
      const owns = () => entries.get(input.threadId) === entry;

      const handle: WorktreeSetupHandle = {
        stage: (id, patch) =>
          publish(entry, (snapshot) => {
            const now = new Date().toISOString();
            let changed = false;
            const stages = snapshot.stages.map((stage) => {
              if (stage.id !== id) return stage;
              const status = patch.status ?? stage.status;
              const next: WorktreeSetupStage = {
                ...stage,
                status,
                ...(status === "running" && stage.startedAt === undefined
                  ? { startedAt: now }
                  : {}),
                ...(isSettled(status) && !isSettled(stage.status) ? { finishedAt: now } : {}),
                ...(patch.percent !== undefined
                  ? { percent: Math.max(0, Math.min(100, Math.round(patch.percent))) }
                  : {}),
                ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
              };
              changed =
                next.status !== stage.status ||
                next.percent !== stage.percent ||
                next.detail !== stage.detail;
              return changed ? next : stage;
            });
            return changed ? { ...snapshot, stages } : snapshot;
          }),
        setCheckout: (checkout) =>
          publish(entry, (snapshot) => ({
            ...snapshot,
            ...(checkout.baseRef ? { baseRef: checkout.baseRef } : {}),
            ...(checkout.branch ? { branch: checkout.branch } : {}),
            ...(checkout.worktreePath ? { worktreePath: checkout.worktreePath } : {}),
            ...(checkout.setupTerminalId ? { setupTerminalId: checkout.setupTerminalId } : {}),
          })),
        appendOutput: (chunk) =>
          Effect.suspend(() =>
            entry.tail.push(chunk)
              ? publish(entry, (snapshot) => ({
                  ...snapshot,
                  outputTail: [...entry.tail.snapshot()],
                }))
              : Effect.void,
          ),
        finish: (status, error) =>
          Effect.suspend(() => {
            entry.cancellable = false;
            return publish(entry, (snapshot) => ({
              ...snapshot,
              status,
              ...(error ? { error } : {}),
              // A failure ends the stage that was running; a cancel stops it.
              stages:
                status === "done"
                  ? snapshot.stages
                  : snapshot.stages.map((stage) =>
                      stage.status === "running"
                        ? {
                            ...stage,
                            status:
                              status === "failed" ? ("failed" as const) : ("skipped" as const),
                            finishedAt: new Date().toISOString(),
                          }
                        : stage,
                    ),
            }));
          }),
        cancelRequested: Effect.sync(() => entry.cancelRequested),
        markUncancellable: Effect.sync(() => {
          if (entry.cancelRequested) return false;
          entry.cancellable = false;
          return true;
        }),
        release: Effect.sync(() => {
          if (owns()) entry.releasedAtMs = Date.now();
        }),
      };
      return Effect.succeed(handle);
    });

  const stream: WorktreeSetupTrackerShape["stream"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading the current snapshot, so a change between
        // the two is delivered rather than lost.
        const subscription = yield* PubSub.subscribe(changes);
        sweep(Date.now());
        const latest = entries.get(threadId)?.snapshot ?? null;
        // A setup that failed or was cancelled already reached its sender
        // through the send's own error. A subscriber arriving now is a retry
        // of that send waiting for the next setup, which the old one must not
        // stand in for.
        const current =
          latest?.status === "failed" || latest?.status === "cancelled" ? null : latest;
        let delivered = latest?.sequence ?? -1;
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filter((snapshot) => {
            if (snapshot.threadId !== threadId || snapshot.sequence <= delivered) return false;
            delivered = snapshot.sequence;
            return true;
          }),
        );
        return current ? Stream.concat(Stream.make(current), live) : live;
      }),
    );

  const cancel: WorktreeSetupTrackerShape["cancel"] = (threadId) =>
    Effect.sync(() => {
      const entry = entries.get(threadId);
      if (!entry || !entry.cancellable || entry.snapshot.status !== "running") return false;
      entry.cancelRequested = true;
      return true;
    });

  return { begin, stream, cancel } satisfies WorktreeSetupTrackerShape;
});

export const WorktreeSetupTrackerLive = Layer.effect(
  WorktreeSetupTracker,
  makeWorktreeSetupTracker,
);
