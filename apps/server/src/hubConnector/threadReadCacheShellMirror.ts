/**
 * The shell the cloud thread index publishes, kept current from domain events.
 *
 * The publisher re-reads the shell whenever the snapshot sequence moves, which
 * during agent streaming is up to once per second. Rebuilding the whole shell
 * each time (every live thread's summary, sessions, latest turns, priorities)
 * cost about 100 ms of SQL and decode at 4.5k threads. The mirror instead
 * re-reads only the projects, workspaces and threads that events named since
 * the last read, the same per-row reads the WebSocket shell stream uses
 * (`toShellStreamEvent`), and patches its copy.
 *
 * A whole rebuild still happens on the first read, after a read failure, for
 * event types the patch does not model, when many rows changed at once, and at
 * least every {@link THREAD_READ_CACHE_SHELL_FULL_REFRESH_MS}: thread priority
 * rankings and background liveness change without domain events, so a patched
 * copy may lag them by up to that interval. Its `updatedAt` only moves forward
 * with the rows it re-reads, and is exact again after each rebuild.
 *
 * @module threadReadCacheShellMirror
 */
import type {
  OrchestrationEvent,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export const THREAD_READ_CACHE_SHELL_FULL_REFRESH_MS = 60_000;
/** Above this many changed rows a rebuild is as cheap as patching. */
const MAX_PATCHED_ROWS = 256;

export type ThreadReadCacheShellQuery = Pick<
  ProjectionSnapshotQueryShape,
  | "getShellSnapshot"
  | "getSnapshotSequence"
  | "getThreadShellById"
  | "getProjectShellById"
  | "getWorktreeShellById"
>;

export interface ThreadReadCacheShellMirror {
  /** Records which rows an event changed. Never reads. */
  readonly record: (event: OrchestrationEvent) => void;
  /** The current shell: patched from recorded changes, or rebuilt. */
  readonly read: () => Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>;
  /** The next read rebuilds the whole shell. */
  readonly invalidate: () => void;
  /** Whole-shell builds so far (diagnostics and tests). */
  readonly fullBuilds: () => number;
}

/** Thread order of the shell query: created_at, then id. */
const compareThreads = (left: OrchestrationThreadShell, right: OrchestrationThreadShell) =>
  left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);

const maxIso = (left: string, right: string) => (right > left ? right : left);

export function makeThreadReadCacheShellMirror(
  query: ThreadReadCacheShellQuery,
  options: { readonly now?: () => number; readonly fullRefreshMs?: number } = {},
): ThreadReadCacheShellMirror {
  const now = options.now ?? Date.now;
  const fullRefreshMs = options.fullRefreshMs ?? THREAD_READ_CACHE_SHELL_FULL_REFRESH_MS;
  let shell: OrchestrationShellSnapshot | null = null;
  let builtAt = 0;
  let fullBuilds = 0;
  let rebuild = true;
  let threads = new Set<ThreadId>();
  let projects = new Set<ProjectId>();
  let worktrees = new Set<WorktreeId>();

  const record = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "project.created":
      case "project.meta-updated":
        projects.add(event.payload.projectId);
        return;
      case "worktree.created":
      case "worktree.archived":
      case "worktree.metaUpdated":
      case "worktree.sourceControlStateUpdated":
      case "worktree.restored":
      case "worktree.checkoutRemoved":
      case "worktree.checkoutRestored":
        worktrees.add(event.payload.worktreeId as WorktreeId);
        return;
      default:
        // Thread events change one thread row; removals read as absent and drop it.
        if (event.aggregateKind === "thread") {
          threads.add(event.aggregateId as ThreadId);
          return;
        }
        // Project deletions, relocations and anything else: rebuild.
        rebuild = true;
    }
  };

  const build = Effect.gen(function* () {
    threads = new Set();
    projects = new Set();
    worktrees = new Set();
    rebuild = false;
    const next = yield* query.getShellSnapshot();
    fullBuilds += 1;
    builtAt = now();
    shell = next;
    return next;
  });

  const patch = (current: OrchestrationShellSnapshot) =>
    Effect.gen(function* () {
      const changedThreads = threads;
      const changedProjects = projects;
      const changedWorktrees = worktrees;
      threads = new Set();
      projects = new Set();
      worktrees = new Set();
      const getWorktreeShellById = query.getWorktreeShellById;
      if (changedWorktrees.size > 0 && getWorktreeShellById === undefined) return yield* build;
      // The sequence first: rows read afterwards are at least as new, and an
      // event committed in between is still recorded for the next read.
      const { snapshotSequence } = yield* query.getSnapshotSequence();
      let updatedAt = current.updatedAt;

      let nextThreads = current.threads;
      if (changedThreads.size > 0) {
        const byId = new Map(current.threads.map((thread) => [thread.id, thread] as const));
        let added = false;
        for (const threadId of changedThreads) {
          const row = yield* query.getThreadShellById(threadId);
          if (Option.isNone(row)) {
            byId.delete(threadId);
            continue;
          }
          if (!byId.has(threadId)) added = true;
          byId.set(threadId, row.value);
          updatedAt = maxIso(updatedAt, row.value.updatedAt);
        }
        // Updates keep their position; additions take the query's order.
        nextThreads = added
          ? [...byId.values()].toSorted(compareThreads)
          : current.threads.flatMap((thread) => {
              const next = byId.get(thread.id);
              return next === undefined ? [] : [next];
            });
      }

      let nextProjects = current.projects;
      for (const projectId of changedProjects) {
        const row = yield* query.getProjectShellById(projectId);
        if (Option.isNone(row)) {
          nextProjects = nextProjects.filter((project) => project.id !== projectId);
          continue;
        }
        updatedAt = maxIso(updatedAt, row.value.updatedAt);
        const index = nextProjects.findIndex((project) => project.id === projectId);
        // A new project changes the project ordering rules; rebuild for it.
        if (index === -1) return yield* build;
        nextProjects = nextProjects.with(index, row.value);
      }

      let nextWorktrees = current.worktrees ?? [];
      for (const worktreeId of changedWorktrees) {
        const row = yield* getWorktreeShellById!(worktreeId);
        const index = nextWorktrees.findIndex((worktree) => worktree.worktreeId === worktreeId);
        // A new or vanished workspace changes the ordering; rebuild for it.
        if (Option.isNone(row) || index === -1) return yield* build;
        updatedAt = maxIso(updatedAt, row.value.updatedAt);
        nextWorktrees = nextWorktrees.with(index, row.value);
      }

      const next: OrchestrationShellSnapshot = {
        ...current,
        snapshotSequence,
        projects: nextProjects,
        ...(current.worktrees === undefined && changedWorktrees.size === 0
          ? {}
          : { worktrees: nextWorktrees }),
        threads: nextThreads,
        updatedAt,
      };
      shell = next;
      return next;
    });

  const read = () =>
    Effect.suspend(() => {
      const current = shell;
      if (
        current === null ||
        rebuild ||
        now() - builtAt >= fullRefreshMs ||
        threads.size + projects.size + worktrees.size > MAX_PATCHED_ROWS
      ) {
        return build;
      }
      if (threads.size + projects.size + worktrees.size === 0) {
        // Nothing recorded: only the sequence may have moved (non-shell events).
        return query.getSnapshotSequence().pipe(
          Effect.map(({ snapshotSequence }) => {
            const next = { ...current, snapshotSequence };
            shell = next;
            return next;
          }),
        );
      }
      return patch(current);
    }).pipe(
      // Whatever failed may have been half-applied: the next read rebuilds.
      Effect.tapError(() =>
        Effect.sync(() => {
          rebuild = true;
        }),
      ),
    );

  return {
    record,
    read,
    invalidate: () => {
      rebuild = true;
    },
    fullBuilds: () => fullBuilds,
  };
}
