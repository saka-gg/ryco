/**
 * The node's one thread list ("shell"), held in memory and patched row by row from committed
 * domain events.
 *
 * Building the shell reads every project, workspace and live thread with their sessions and
 * latest turns: about 100 ms of SQL and decode at 4.5k threads. Every reconnecting client, the
 * push alert publisher, the Hub thread cache, Agent Control and storage used to build their own,
 * and a memo of the last build was useless while an agent streamed, because every event made it
 * stale. This copy instead re-reads only the projects, workspaces and threads that events named
 * since the last read, once for every reader, and hands the same row objects to all of them.
 *
 * Correctness rests on three rules:
 * - The engine records each committed event before it publishes it, in sequence order
 *   (`record`), so any reader that saw an event, or awaited the command that wrote it, finds it
 *   recorded.
 * - A row is re-read after the events naming it were recorded, so it is at least as new as them.
 *   A patch therefore advances the copy's `snapshotSequence` to the highest sequence recorded
 *   when the patch began: every event up to it is reflected, and a subscriber replays only the
 *   events after it, as with a fresh build.
 * - Anything the patch does not model (a project deletion, a workspace relocation, a new project
 *   or a vanished workspace, a failed read, more than {@link MAX_PATCHED_ROWS} changed rows)
 *   rebuilds the whole copy in one read transaction, and so does every read after
 *   {@link SHELL_COPY_FULL_REFRESH_MS} as a safety net.
 *
 * Two fields change without events: a thread's background liveness (in memory) and the ended
 * pull request watches a shell shows for a while. Both are applied again as the copy is served,
 * so a served snapshot equals what a fresh build would produce. The one exception is the
 * snapshot's own `updatedAt`: a patch only moves it forward with the rows it re-reads (a build
 * also counts deleted rows and projector cursors); clients do not order by it.
 *
 * @module shellSnapshotCopy
 */
import type {
  OrchestrationEvent,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationThreadShell,
  OrchestrationWorktreeShell,
  ProjectId,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import { pullRequestWatchShellAt } from "@ryco/shared/pullRequestWatchSummary";
import { Deferred, Effect, Exit, Option } from "effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  type ProjectionSnapshotQueryShape,
  type ProjectionStubbedShellSnapshot,
  type ShellChangesSince,
  stubArchivedThreads,
} from "./Services/ProjectionSnapshotQuery.ts";
import type { ThreadBackgroundLiveness } from "./ThreadBackgroundLiveness.ts";

/** A safety net: the copy is rebuilt from scratch at least this often while it is read. */
export const SHELL_COPY_FULL_REFRESH_MS = 5 * 60_000;
/** Above this many changed rows a rebuild is as cheap as patching. */
export const MAX_PATCHED_ROWS = 256;

export type ShellSnapshotCopySource = Pick<
  ProjectionSnapshotQueryShape,
  "getThreadShellById" | "getProjectShellById" | "getWorktreeShellById"
> & {
  /** The whole shell, its rows and sequence read in one transaction. */
  readonly buildShell: () => Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>;
};

export interface ShellSnapshotCopyOptions {
  readonly now?: () => number;
  readonly fullRefreshMs?: number;
  /** Background liveness as it is now; absent, the rows keep what they were read with. */
  readonly liveness?: {
    readonly get: (threadId: string) => ThreadBackgroundLiveness;
    readonly liveThreadIds: () => ReadonlyArray<string>;
  };
}

export interface ShellSnapshotCopyStats {
  readonly fullBuilds: number;
  readonly patches: number;
  readonly patchedRows: number;
}

export interface ShellSnapshotCopy {
  /** Records committed events, ascending. Never reads, never throws. */
  readonly record: (events: ReadonlyArray<OrchestrationEvent>) => void;
  /** Recording starts after `sequence`: changes since then can be answered (`changesSince`). */
  readonly startChangeIndex: (sequence: number) => void;
  /**
   * The shell's changes after `sequence`, from the in-memory change index: none when that index
   * does not reach back to it (before the server started, or before an event it cannot attribute
   * to rows, such as a project deletion or a workspace relocation).
   */
  readonly changesSince: (
    sequence: number,
  ) => Effect.Effect<Option.Option<ShellChangesSince>, ProjectionRepositoryError>;
  /** The current shell: patched from recorded changes, or built. */
  readonly read: () => Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>;
  /** The current shell with archived threads as stubs (see `stubArchivedThreads`). */
  readonly readStubbed: () => Effect.Effect<
    ProjectionStubbedShellSnapshot,
    ProjectionRepositoryError
  >;
  /** One thread's current row, none when it is deleted. Patches the copy, builds it if absent. */
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;
  /** Whether a built copy is held. */
  readonly isHeld: () => boolean;
  /** The next read rebuilds the whole copy. */
  readonly invalidate: () => void;
  readonly stats: () => ShellSnapshotCopyStats;
}

/** Shell thread order: created_at, then id, compared like SQLite's BINARY collation. */
const threadOrder = (left: OrchestrationThreadShell, right: OrchestrationThreadShell) =>
  left.createdAt < right.createdAt
    ? -1
    : left.createdAt > right.createdAt
      ? 1
      : left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0;

const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Workspace order of the shell query: project, manual position, created_at, id. */
const worktreeOrder = (left: OrchestrationWorktreeShell, right: OrchestrationWorktreeShell) =>
  compareStrings(left.projectId, right.projectId) ||
  (left.manualPosition ?? 0) - (right.manualPosition ?? 0) ||
  compareStrings(left.createdAt, right.createdAt) ||
  compareStrings(left.worktreeId, right.worktreeId);

const maxIso = (left: string, right: string | null | undefined) =>
  right != null && right > left ? right : left;

/** The newest time a thread row contributes to the shell's `updatedAt`, as a build counts it. */
const threadUpdatedAt = (updatedAt: string, thread: OrchestrationThreadShell) => {
  let next = maxIso(updatedAt, thread.updatedAt);
  next = maxIso(next, thread.session?.updatedAt);
  const turn = thread.latestTurn;
  if (turn !== null) {
    next = maxIso(next, turn.requestedAt);
    next = maxIso(next, turn.startedAt);
    next = maxIso(next, turn.completedAt);
  }
  return next;
};

/** Whether a row carries a field that changes without events (see the module docs). */
const isVolatile = (thread: OrchestrationThreadShell) =>
  thread.backgroundLiveness != null || (thread.pullRequestWatches?.ended.length ?? 0) > 0;

export function makeShellSnapshotCopy(
  source: ShellSnapshotCopySource,
  options: ShellSnapshotCopyOptions = {},
): ShellSnapshotCopy {
  const now = options.now ?? Date.now;
  const fullRefreshMs = options.fullRefreshMs ?? SHELL_COPY_FULL_REFRESH_MS;
  const liveness = options.liveness;

  let shell: OrchestrationShellSnapshot | null = null;
  /** Thread id to its index in `shell.threads`. */
  let threadIndex = new Map<string, number>();
  /** Threads whose rows hold a field that changes without events. */
  const volatileThreads = new Set<string>();
  let builtAt = 0;
  let rebuild = true;
  let threads = new Set<ThreadId>();
  let projects = new Set<ProjectId>();
  let worktrees = new Set<WorktreeId>();
  /** What the refresh in flight is re-reading: `"all"` while it rebuilds. */
  let inFlight: { readonly threads: ReadonlySet<string> } | "all" | null = null;
  let running: Deferred.Deferred<void, ProjectionRepositoryError> | null = null;
  /** Highest sequence recorded; a patch serves the shell at the value it began with. */
  let recordedThrough = 0;
  /** Counts the changes recorded; a refresh covers every change counted before it began. */
  let changeCount = 0;
  let appliedCount = 0;
  let fullBuilds = 0;
  let patches = 0;
  let patchedRows = 0;
  const stubbed = new WeakMap<OrchestrationShellSnapshot, ProjectionStubbedShellSnapshot>();

  /**
   * The change index: the sequence of the last event that named each row, and of each removal,
   * for every event after `indexedSince`. `null` until the engine starts it.
   */
  let indexedSince: number | null = null;
  const threadChanges = new Map<string, number>();
  const threadRemovals = new Map<string, number>();
  const projectChanges = new Map<string, number>();
  const worktreeChanges = new Map<string, number>();
  const worktreeRemovals = new Map<string, number>();
  const restartIndex = (sequence: number) => {
    indexedSince = sequence;
    threadChanges.clear();
    threadRemovals.clear();
    projectChanges.clear();
    worktreeChanges.clear();
    worktreeRemovals.clear();
  };
  const indexOne = (event: OrchestrationEvent) => {
    if (indexedSince === null || event.sequence <= indexedSince) return;
    switch (event.type) {
      case "project.created":
      case "project.meta-updated":
      case "project.avatar-set":
        projectChanges.set(event.payload.projectId, event.sequence);
        return;
      case "worktree.created":
      case "worktree.archived":
      case "worktree.metaUpdated":
      case "worktree.sourceControlStateUpdated":
      case "worktree.restored":
      case "worktree.checkoutRemoved":
      case "worktree.checkoutRestored":
      case "worktree.manualPositionSet":
        worktreeChanges.set(event.payload.worktreeId, event.sequence);
        return;
      case "worktree.deleted":
        worktreeRemovals.set(event.payload.worktreeId, event.sequence);
        return;
      default:
        if (event.aggregateKind === "thread") {
          threadChanges.set(event.aggregateId, event.sequence);
          if (event.type === "thread.deleted" || event.type === "thread.trashed") {
            threadRemovals.set(event.aggregateId, event.sequence);
          }
          return;
        }
        // A project deletion or a relocation also changes rows its event does not name: the
        // index starts over after it.
        restartIndex(event.sequence);
    }
  };

  const requestRebuild = () => {
    rebuild = true;
    changeCount += 1;
  };

  const recordOne = (event: OrchestrationEvent) => {
    if (event.sequence > recordedThrough) recordedThrough = event.sequence;
    // A built copy already reflects every event the build could see.
    if (shell !== null && event.sequence <= shell.snapshotSequence && !rebuild) return;
    changeCount += 1;
    switch (event.type) {
      case "project.created":
      case "project.meta-updated":
      case "project.avatar-set":
        projects.add(event.payload.projectId);
        return;
      case "worktree.created":
      case "worktree.archived":
      case "worktree.metaUpdated":
      case "worktree.sourceControlStateUpdated":
      case "worktree.restored":
      case "worktree.checkoutRemoved":
      case "worktree.checkoutRestored":
      case "worktree.manualPositionSet":
        worktrees.add(event.payload.worktreeId as WorktreeId);
        return;
      default:
        // Thread events change one thread row; removals read as absent and drop it.
        if (event.aggregateKind === "thread") {
          threads.add(event.aggregateId as ThreadId);
          return;
        }
        // Project deletions, relocations, workspace deletions and anything else: rebuild.
        rebuild = true;
    }
  };

  const record = (events: ReadonlyArray<OrchestrationEvent>) => {
    try {
      for (const event of events) {
        recordOne(event);
        indexOne(event);
      }
    } catch {
      requestRebuild();
      if (indexedSince !== null) restartIndex(recordedThrough);
    }
  };

  const rebuildDue = () =>
    shell === null ||
    rebuild ||
    now() - builtAt >= fullRefreshMs ||
    threads.size + projects.size + worktrees.size > MAX_PATCHED_ROWS;

  const indexThreads = (list: ReadonlyArray<OrchestrationThreadShell>) => {
    threadIndex = new Map(list.map((thread, index) => [thread.id, index] as const));
    volatileThreads.clear();
    for (const thread of list) if (isVolatile(thread)) volatileThreads.add(thread.id);
  };

  const build = Effect.gen(function* () {
    threads = new Set();
    projects = new Set();
    worktrees = new Set();
    rebuild = false;
    inFlight = "all";
    const next = yield* source.buildShell();
    fullBuilds += 1;
    builtAt = now();
    indexThreads(next.threads);
    shell = next;
  });

  const patch = (current: OrchestrationShellSnapshot) =>
    Effect.gen(function* () {
      const changedThreads = threads;
      const changedProjects = projects;
      const changedWorktrees = worktrees;
      threads = new Set();
      projects = new Set();
      worktrees = new Set();
      inFlight = { threads: changedThreads };
      // Every event up to here is recorded, so every row read below reflects it.
      const servedThrough = recordedThrough;
      const getWorktreeShellById = source.getWorktreeShellById;
      if (changedWorktrees.size > 0 && getWorktreeShellById === undefined) return yield* build;

      const threadRows = new Map<ThreadId, Option.Option<OrchestrationThreadShell>>();
      for (const threadId of changedThreads) {
        threadRows.set(threadId, yield* source.getThreadShellById(threadId));
      }
      const projectRows = [];
      for (const projectId of changedProjects) {
        const row = yield* source.getProjectShellById(projectId);
        // A new project changes the project ordering rules; rebuild for it.
        if (Option.isSome(row) && !current.projects.some((project) => project.id === projectId)) {
          return yield* build;
        }
        projectRows.push({ projectId, row });
      }
      const worktreeRows = [];
      for (const worktreeId of changedWorktrees) {
        const row = yield* getWorktreeShellById!(worktreeId);
        // A new or vanished workspace changes the ordering; rebuild for it.
        if (
          Option.isNone(row) ||
          !(current.worktrees ?? []).some((worktree) => worktree.worktreeId === worktreeId)
        ) {
          return yield* build;
        }
        worktreeRows.push(row.value);
      }

      // Applied in one synchronous step onto the copy as it is now.
      const base = shell ?? current;
      let updatedAt = base.updatedAt;
      let nextThreads = base.threads;
      let reindex = false;
      if (threadRows.size > 0) {
        const list = base.threads.slice();
        const added: Array<OrchestrationThreadShell> = [];
        for (const [threadId, row] of threadRows) {
          const index = threadIndex.get(threadId);
          if (Option.isNone(row)) {
            if (index !== undefined) {
              list[index] = undefined as never;
              reindex = true;
            }
            continue;
          }
          updatedAt = threadUpdatedAt(updatedAt, row.value);
          if (index === undefined) added.push(row.value);
          else list[index] = row.value;
          if (isVolatile(row.value)) volatileThreads.add(threadId);
          else volatileThreads.delete(threadId);
        }
        nextThreads = reindex ? list.filter((thread) => thread !== undefined) : list;
        if (added.length > 0) {
          // Additions take the query's order; existing rows keep theirs.
          nextThreads = [...nextThreads, ...added].toSorted(threadOrder);
          reindex = true;
        }
        patchedRows += threadRows.size;
      }
      if (reindex) indexThreads(nextThreads);

      let nextProjects = base.projects;
      for (const { projectId, row } of projectRows) {
        if (Option.isNone(row)) {
          nextProjects = nextProjects.filter((project) => project.id !== projectId);
          continue;
        }
        updatedAt = maxIso(updatedAt, row.value.updatedAt);
        const index = nextProjects.findIndex((project) => project.id === projectId);
        nextProjects = nextProjects.with(index, row.value);
      }
      let nextWorktrees = base.worktrees;
      for (const row of worktreeRows) {
        const list = nextWorktrees ?? [];
        updatedAt = maxIso(updatedAt, row.updatedAt);
        updatedAt = maxIso(updatedAt, row.archivedAt);
        const index = list.findIndex((worktree) => worktree.worktreeId === row.worktreeId);
        nextWorktrees = list.with(index, row);
      }
      // A manual reorder moves a workspace: keep the query's order.
      if (worktreeRows.length > 0 && nextWorktrees !== undefined) {
        nextWorktrees = nextWorktrees.toSorted(worktreeOrder);
      }
      patchedRows += projectRows.length + worktreeRows.length;
      patches += 1;
      shell = {
        ...base,
        snapshotSequence: Math.max(base.snapshotSequence, servedThrough),
        projects: nextProjects,
        ...(nextWorktrees === undefined ? {} : { worktrees: nextWorktrees }),
        threads: nextThreads,
        updatedAt,
      };
    });

  /** One refresh: covers every change counted before it began. */
  const refreshOnce = Effect.suspend(() => {
    const covered = changeCount;
    const work = rebuildDue() ? build : patch(shell!);
    return work.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          appliedCount = Math.max(appliedCount, covered);
        }),
      ),
      // Whatever failed (or died) may have been half-applied: the next read rebuilds.
      Effect.onError(() => Effect.sync(requestRebuild)),
      Effect.ensuring(
        Effect.sync(() => {
          inFlight = null;
        }),
      ),
    );
  });

  const startRefresh = () => {
    const done = Deferred.makeUnsafe<void, ProjectionRepositoryError>();
    running = done;
    return refreshOnce.pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.sync(() => {
          running = null;
          Deferred.doneUnsafe(done, Exit.asVoid(exit));
        }),
      ),
      // Detached, so a reader that stops waiting never interrupts a refresh others wait on.
      Effect.forkDetach,
      Effect.andThen(Deferred.await(done)),
    );
  };

  const needsWork = (target: number) => appliedCount < target || rebuildDue();

  /** Waits until every change recorded before the call is applied. */
  const ensureCurrent = Effect.suspend(() => {
    const target = changeCount;
    const loop: Effect.Effect<void, ProjectionRepositoryError> = Effect.suspend(() => {
      if (!needsWork(target)) return Effect.void;
      const pending = running;
      const step = pending === null ? startRefresh() : Deferred.await(pending);
      return step.pipe(Effect.andThen(loop));
    });
    return loop;
  });

  /** Applies the fields that change without events, writing changes back into the copy. */
  const serve = (): OrchestrationShellSnapshot => {
    const current = shell!;
    if (liveness === undefined && volatileThreads.size === 0) return current;
    const nowMs = now();
    const candidates = new Set<string>(volatileThreads);
    for (const threadId of liveness?.liveThreadIds() ?? []) candidates.add(threadId);
    let list: Array<OrchestrationThreadShell> | null = null;
    for (const threadId of candidates) {
      const index = threadIndex.get(threadId);
      if (index === undefined) continue;
      const row = current.threads[index]!;
      const next = withCurrentVolatileFields(row, nowMs);
      if (next === row) continue;
      (list ??= current.threads.slice())[index] = next;
      if (isVolatile(next)) volatileThreads.add(threadId);
      else volatileThreads.delete(threadId);
    }
    if (list === null) return current;
    const next = { ...current, threads: list };
    shell = next;
    return next;
  };

  const withCurrentVolatileFields = (
    row: OrchestrationThreadShell,
    nowMs: number,
  ): OrchestrationThreadShell => {
    const backgroundLiveness =
      liveness === undefined ? row.backgroundLiveness : liveness.get(row.id);
    const watches =
      row.pullRequestWatches === undefined
        ? undefined
        : (pullRequestWatchShellAt(row.pullRequestWatches, nowMs) ?? undefined);
    if (
      (backgroundLiveness ?? null) === (row.backgroundLiveness ?? null) &&
      watches === row.pullRequestWatches
    ) {
      return row;
    }
    const { pullRequestWatches: _watches, ...rest } = row;
    return {
      ...rest,
      backgroundLiveness,
      ...(watches === undefined ? {} : { pullRequestWatches: watches }),
    };
  };

  const read = () => ensureCurrent.pipe(Effect.map(serve));

  const readThread = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const current = shell;
      // A row nothing changed since it was read, in a copy not due for a rebuild, is current.
      const settled =
        current !== null &&
        !rebuildDue() &&
        inFlight !== "all" &&
        !threads.has(threadId) &&
        !(inFlight?.threads.has(threadId) ?? false);
      const ready = settled ? Effect.void : ensureCurrent;
      return ready.pipe(
        Effect.map(() => {
          const snapshot = serve();
          const index = threadIndex.get(threadId);
          return index === undefined ? Option.none() : Option.some(snapshot.threads[index]!);
        }),
      );
    });

  const readStubbed = () =>
    read().pipe(
      Effect.map((snapshot) => {
        const cached = stubbed.get(snapshot);
        if (cached !== undefined) return cached;
        const next = stubArchivedThreads(snapshot);
        stubbed.set(snapshot, next);
        return next;
      }),
    );

  const changesSince = (sequence: number) =>
    Effect.suspend(() => {
      const since = indexedSince;
      if (since === null || sequence < since) return Effect.succeed(Option.none());
      return read().pipe(
        Effect.map((snapshot): Option.Option<ShellChangesSince> => {
          // The index may have started over, or reached past the served copy, meanwhile.
          if (indexedSince === null || sequence < indexedSince) return Option.none();
          // A build may have seen events the engine has not recorded (indexed) yet: the
          // answer covers only what the index has, and the replay sends the rest.
          const through = Math.min(snapshot.snapshotSequence, recordedThrough);
          if (sequence > through) return Option.none();
          const inRange = (at: number) => at > sequence && at <= through;
          const items: Array<OrchestrationShellStreamEvent> = [];
          const projectsById = new Map(snapshot.projects.map((row) => [row.id, row] as const));
          for (const [projectId, at] of projectChanges) {
            const project = projectsById.get(projectId as ProjectId);
            if (inRange(at) && project !== undefined) {
              items.push({ kind: "project-upserted", sequence: at, project });
            }
          }
          const worktreesById = new Map(
            (snapshot.worktrees ?? []).map((row) => [row.worktreeId, row] as const),
          );
          for (const [worktreeId, at] of worktreeChanges) {
            const worktree = worktreesById.get(worktreeId as WorktreeId);
            if (inRange(at) && worktree !== undefined) {
              items.push({ kind: "worktree-upserted", sequence: at, worktree });
            }
          }
          for (const [worktreeId, at] of worktreeRemovals) {
            if (inRange(at) && !worktreesById.has(worktreeId as WorktreeId)) {
              items.push({
                kind: "worktree-removed",
                sequence: at,
                worktreeId: worktreeId as WorktreeId,
              });
            }
          }
          let threadCount = 0;
          const removed = new Set<string>();
          const pushRemoval = (threadId: string, at: number) => {
            if (removed.has(threadId)) return;
            removed.add(threadId);
            threadCount += 1;
            items.push({ kind: "thread-removed", sequence: at, threadId: threadId as ThreadId });
          };
          for (const [threadId, at] of threadChanges) {
            if (!inRange(at)) continue;
            const index = threadIndex.get(threadId);
            if (index === undefined) {
              pushRemoval(threadId, Math.min(threadRemovals.get(threadId) ?? at, at));
              continue;
            }
            threadCount += 1;
            items.push({ kind: "thread-upserted", sequence: at, thread: snapshot.threads[index]! });
          }
          // A removal in range whose thread an event after the range names again (a replayed
          // event of a gone thread sends nothing): the client still learns it is gone.
          for (const [threadId, at] of threadRemovals) {
            if (inRange(at) && !threadIndex.has(threadId)) pushRemoval(threadId, at);
          }
          items.sort((left, right) => left.sequence - right.sequence);
          let liveThreadCount = 0;
          for (const thread of snapshot.threads)
            if (thread.archivedAt === null) liveThreadCount += 1;
          return Option.some({ snapshotSequence: through, items, threadCount, liveThreadCount });
        }),
      );
    });

  return {
    record,
    startChangeIndex: (sequence) => {
      // Everything up to here was committed before recording started: every build reflects it.
      if (sequence > recordedThrough) recordedThrough = sequence;
      if (indexedSince === null) restartIndex(sequence);
    },
    changesSince,
    read,
    readStubbed,
    readThread,
    isHeld: () => shell !== null,
    invalidate: requestRebuild,
    stats: () => ({ fullBuilds, patches, patchedRows }),
  };
}
