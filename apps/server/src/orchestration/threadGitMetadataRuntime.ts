/**
 * The thread git metadata runtime: follows each thread's checkout into its
 * thread and workspace records, and refreshes the checkout's published status
 * after git and forge commands (seen in a command's text or reported by the
 * provider itself). The reactor layer loads it with the first provider event
 * that can ask for a sync.
 *
 * Per thread there is at most one queued sync plus one running: requests that
 * arrive meanwhile merge into the queued one. Lanes are per thread, so one
 * thread's slow refresh never delays another's. HEAD is read from disk; git
 * runs only for a layout the file read cannot follow, and for the status
 * refreshes, in the background process lane.
 *
 * @module threadGitMetadataRuntime
 */
import { access } from "node:fs/promises";
import path from "node:path";

import {
  CommandId,
  type GitManagerServiceError,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type OrchestrationWorktreeShell,
  type ProjectId,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@ryco/contracts";
import { makeKeyedSerialWorker } from "@ryco/shared/KeyedSerialWorker";
import { isChatProject } from "@ryco/shared/projectKind";
import { losslessBackpressureQueuePolicy } from "@ryco/shared/QueuePolicy";
import { mergeVcsCommandEffects } from "@ryco/shared/vcsCommand";
import { Cause, Clock, Duration, Effect, Option, type Scope } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { canonicalizeFilesystemPath } from "../git/worktreeReconciliation.ts";
import { ignoreCauseLogOnceEvery } from "../logOnceEvery.ts";
import { inBackgroundProcessLane } from "../processGovernor.ts";
import { resolveProjectPreferences } from "../project/projectPreferences.ts";
import type { ServerSettingsShape } from "../serverSettings.ts";
import { readCheckoutHead } from "../vcs/gitCheckoutHead.ts";
import type { VcsStatusBroadcasterShape } from "../vcs/VcsStatusBroadcaster.ts";
import { isBranchPreconditionFailure } from "./commandInvariants.ts";
import type { OrchestrationDispatchError } from "./Errors.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import {
  EMPTY_SYNC_REQUEST,
  UNTRACKED_TURN,
  combineTurnOverlaps,
  countedSignalEffect,
  decideThreadBranchAdoption,
  gitSyncTriggerFor,
  isCommandOnlyRequest,
  makeThreadTurnOwnership,
  mergeThreadGitSyncRequests,
  type ThreadBranchAdoption,
  type ThreadGitSyncRequest,
  type TurnOverlap,
} from "./threadGitMetadata.ts";

export interface ThreadGitMetadataOptions {
  /** Wait after a mid-turn command before reading HEAD, so a burst reads it once. Default 250 ms. */
  readonly midTurnSettleMs?: number;
  /** Mid-turn spacing of full (remote) refreshes per checkout. Default 5 s. */
  readonly remoteRefreshMinIntervalMs?: number;
  /** One sync's budget, refreshes included. Default 30 s. */
  readonly syncTimeoutMs?: number;
}

export interface ThreadGitMetadataDependencies {
  readonly engine: OrchestrationEngineShape;
  readonly snapshots: ProjectionSnapshotQueryShape;
  readonly vcsStatus: VcsStatusBroadcasterShape;
  readonly settings: ServerSettingsShape;
}

export interface ThreadGitMetadataRuntime {
  /** Synchronous bookkeeping plus at most one enqueue; never reads disk or spawns. */
  readonly offer: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

const WORKER_CAPACITY = 1_024;
/** Overlapping threads whose shells one sync reads; more counts as a shared checkout. */
const MAX_OVERLAP_SHELL_READS = 64;
/** Checkouts whose last remote refresh time is kept (least recently used dropped). */
const REMOTE_REFRESH_MEMO_SIZE = 256;
/** Parent folders searched for `.git`, like git's own discovery. */
const MAX_GIT_DISCOVERY_DEPTH = 64;
const REFRESH_FAILURE_LOG_WINDOW = Duration.hours(1);

type CheckoutHeadLocation =
  /** Not inside a git repository (no `.git` up to the root). */
  | { readonly _tag: "none" }
  /** A `.git` the file read cannot follow (bare, reftable, unusual layout): ask git. */
  | { readonly _tag: "unparsed"; readonly root: string }
  | { readonly _tag: "head"; readonly root: string; readonly branch: string | null };

const pathExists = (target: string) =>
  Effect.promise(() =>
    access(target).then(
      () => true,
      () => false,
    ),
  );

/**
 * The HEAD of the repository `cwd` belongs to, found the way git finds it: the
 * nearest folder at or above `cwd` with a `.git`. A project rooted in a
 * subfolder of its repository reads the repository's HEAD. A checkout folder
 * that is gone (a removed worktree) belongs to no repository: its parents may
 * hold an unrelated one. So does a worktree checkout without its own `.git`
 * (`ownGitOnly`): a worktree always has one at its root.
 */
export const locateCheckoutHead = Effect.fn("locateCheckoutHead")(function* (
  cwd: string,
  options?: { readonly ownGitOnly?: boolean },
) {
  let folder = path.resolve(cwd);
  const maxDepth = options?.ownGitOnly === true ? 1 : MAX_GIT_DISCOVERY_DEPTH;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (yield* pathExists(path.join(folder, ".git"))) {
      const root = canonicalizeFilesystemPath(folder);
      const head = yield* readCheckoutHead(folder);
      return head === null
        ? ({ _tag: "unparsed", root } as const)
        : ({ _tag: "head", root, branch: head.branch } as const);
    }
    // Checked only when the checkout has no `.git` of its own, so the usual read costs nothing more.
    if (depth === 0 && !(yield* pathExists(folder))) break;
    const parent = path.dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return { _tag: "none" } as const satisfies CheckoutHeadLocation;
});

const isWithin = (candidate: string, root: string) =>
  candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

const remoteRefreshMemoTouch = (memo: Map<string, number>, key: string, atMs: number) => {
  memo.delete(key);
  memo.set(key, atMs);
  if (memo.size > REMOTE_REFRESH_MEMO_SIZE) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
};

export const makeThreadGitMetadataRuntime = (
  deps: ThreadGitMetadataDependencies,
  options?: ThreadGitMetadataOptions,
): Effect.Effect<ThreadGitMetadataRuntime, never, Scope.Scope> =>
  Effect.gen(function* () {
    const settleMs = options?.midTurnSettleMs ?? 250;
    const remoteMinIntervalMs = options?.remoteRefreshMinIntervalMs ?? 5_000;
    const syncTimeout = Duration.millis(options?.syncTimeoutMs ?? 30_000);
    const scope = yield* Effect.scope;

    const ownership = makeThreadTurnOwnership();
    const pending = new Map<ThreadId, ThreadGitSyncRequest>();
    const queued = new Set<ThreadId>();
    /** Threads owed a remote refresh the per-checkout spacing held back. */
    const remoteOwed = new Set<ThreadId>();
    /** Threads with a timer armed to deliver their owed remote refresh. */
    const remoteTimers = new Set<ThreadId>();
    const lastRemoteRefreshAt = new Map<string, number>();

    const readProject = (projectId: ProjectId) =>
      deps.snapshots.getProjectShellById(projectId).pipe(Effect.map(Option.getOrUndefined));

    const readOwnWorktreeRecord = Effect.fn("readOwnWorktreeRecord")(function* (
      thread: OrchestrationThreadShell,
    ) {
      if (
        thread.worktreePath === null ||
        !thread.worktreeId ||
        !deps.snapshots.getWorktreeShellById
      ) {
        return null;
      }
      const worktree = Option.getOrUndefined(
        yield* deps.snapshots.getWorktreeShellById(thread.worktreeId),
      );
      // Only the thread's own live workspace: never the main checkout's record.
      if (
        worktree === undefined ||
        worktree.origin === "main" ||
        worktree.archivedAt !== null ||
        worktree.checkoutRemovedAt ||
        worktree.worktreePath === null ||
        canonicalizeFilesystemPath(worktree.worktreePath) !==
          canonicalizeFilesystemPath(thread.worktreePath)
      ) {
        return null;
      }
      return worktree;
    });

    /**
     * Whether another thread may have moved this checkout: one whose turn ran at
     * the same time works in the same checkout. When the turn's start was not
     * seen (it began before this process subscribed), a project-root thread is
     * treated as shared, and a worktree thread checks the turns running now.
     */
    const sharesCheckout = Effect.fn("sharesCheckout")(function* (input: {
      readonly threadId: ThreadId;
      readonly thread: OrchestrationThreadShell;
      readonly overlap: TurnOverlap;
      readonly root: string;
      readonly checkout: string;
      readonly project: OrchestrationProjectShell;
    }) {
      const { overlap } = input;
      if (overlap.overflowed) return true;
      if (!overlap.tracked && input.thread.worktreePath === null) return true;
      const others = overlap.tracked
        ? [...overlap.overlaps]
        : ownership.running().filter((threadId) => threadId !== input.threadId);
      if (others.length > MAX_OVERLAP_SHELL_READS) return true;
      const projects = new Map<ProjectId, OrchestrationProjectShell | undefined>([
        [input.project.id, input.project],
      ]);
      for (const otherId of others) {
        const other = Option.getOrUndefined(yield* deps.snapshots.getThreadShellById(otherId));
        if (other === undefined) continue;
        if (!projects.has(other.projectId)) {
          projects.set(other.projectId, yield* readProject(other.projectId));
        }
        const project = projects.get(other.projectId);
        const cwd = resolveThreadWorkspaceCwd({
          thread: other,
          projects: project === undefined ? [] : [project],
        });
        if (cwd === undefined) continue;
        const canonical = canonicalizeFilesystemPath(cwd);
        if (canonical === input.checkout || isWithin(canonical, input.root)) return true;
      }
      return false;
    });

    /** Worktree record first, then the thread; a lost guard stops the adoption. */
    const adopt = Effect.fn("adoptCheckoutBranch")(function* (input: {
      readonly threadId: ThreadId;
      readonly thread: OrchestrationThreadShell;
      readonly worktree: OrchestrationWorktreeShell | null;
      readonly decision: Extract<ThreadBranchAdoption, { _tag: "adopt" }>;
      readonly trigger: string;
    }) {
      const { decision, threadId } = input;
      const outcome = (record: "workspace" | "thread") => (error: OrchestrationDispatchError) =>
        isBranchPreconditionFailure(error)
          ? Effect.logDebug("thread branch follow lost a race to a newer branch", {
              threadId,
              record,
              detail: error.message,
            }).pipe(Effect.as("lost" as const))
          : Effect.logWarning("thread branch follow could not record the branch", {
              threadId,
              record,
              branch: decision.branch,
              detail: error.message,
            }).pipe(Effect.as("failed" as const));
      let adopted = false;
      if (decision.worktree !== null && input.worktree !== null) {
        const result = yield* deps.engine
          .dispatch({
            type: "worktree.meta.update",
            commandId: CommandId.make(`server:thread-git-adopt-meta:${crypto.randomUUID()}`),
            worktreeId: input.worktree.worktreeId,
            branch: decision.branch,
            expectedBranch: decision.worktree.expectedBranch,
            changedAt: new Date().toISOString(),
          })
          .pipe(Effect.as("applied" as const), Effect.catch(outcome("workspace")));
        if (result === "lost") return false;
        adopted = result === "applied";
      }
      if (decision.thread !== null) {
        // Branch only, never the path: a path change is a checkout move, not a follow.
        const result = yield* deps.engine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(`server:thread-git-adopt:${crypto.randomUUID()}`),
            threadId,
            branch: decision.branch,
            expectedBranch: decision.thread.expectedBranch,
          })
          .pipe(Effect.as("applied" as const), Effect.catch(outcome("thread")));
        adopted ||= result === "applied";
      }
      if (adopted) {
        yield* Effect.logInfo("thread branch followed its checkout", {
          threadId,
          previousBranch: input.thread.branch,
          branch: decision.branch,
          trigger: input.trigger,
        });
      }
      return adopted;
    });

    const refreshInBackground = (
      kind: "local" | "full",
      checkout: string,
      refresh: Effect.Effect<unknown, GitManagerServiceError>,
    ) =>
      inBackgroundProcessLane(refresh).pipe(
        ignoreCauseLogOnceEvery({
          key: `threadGitSync.refresh:${checkout}`,
          message: "thread git sync could not refresh the checkout's status",
          level: "Warn",
          window: REFRESH_FAILURE_LOG_WINDOW,
          fields: { checkout, kind },
        }),
      );

    const scheduleRemoteDue = (threadId: ThreadId, delayMs: number) => {
      if (remoteTimers.has(threadId)) return Effect.void;
      remoteTimers.add(threadId);
      return Effect.sleep(Duration.millis(Math.max(1, delayMs))).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            remoteTimers.delete(threadId);
            return request(threadId, { ...EMPTY_SYNC_REQUEST, remoteDue: true });
          }),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    };

    /**
     * A full refresh (fetch, upstream, change requests) only for commands that
     * reach the remote or the forge: at most one per checkout per spacing
     * interval mid-turn, a held-back one delivered when the spacing allows or at
     * the turn's end. Otherwise a local refresh when the branch was adopted, a
     * local command ran or the turn was stopped (the checkpoint reactor refreshes
     * after completed turns only).
     */
    const refreshAfterSync = Effect.fn("refreshAfterSync")(function* (input: {
      readonly threadId: ThreadId;
      readonly checkout: string;
      readonly canonicalCheckout: string;
      readonly request: ThreadGitSyncRequest;
      readonly adopted: boolean;
      readonly localRefreshed: boolean;
    }) {
      const { request, threadId } = input;
      const owed = remoteOwed.has(threadId) && (request.turnEnd !== null || request.remoteDue);
      if (request.command?.remote === true || owed) {
        const nowMs = yield* Clock.currentTimeMillis;
        const last = lastRemoteRefreshAt.get(input.canonicalCheckout);
        const waitMs =
          request.turnEnd !== null || last === undefined ? 0 : last + remoteMinIntervalMs - nowMs;
        if (waitMs <= 0) {
          remoteOwed.delete(threadId);
          remoteRefreshMemoTouch(lastRemoteRefreshAt, input.canonicalCheckout, nowMs);
          yield* refreshInBackground(
            "full",
            input.checkout,
            deps.vcsStatus.refreshStatus(input.checkout),
          );
          return;
        }
        remoteOwed.add(threadId);
        yield* scheduleRemoteDue(threadId, waitMs);
      }
      if (
        !input.localRefreshed &&
        (input.adopted || request.command?.local === true || request.turnEnd?.aborted === true)
      ) {
        yield* refreshInBackground(
          "local",
          input.checkout,
          deps.vcsStatus.refreshLocalStatus(input.checkout),
        );
      }
    });

    const syncThread = Effect.fn("ThreadGitMetadata.syncThread")(function* (
      threadId: ThreadId,
      queued: ThreadGitSyncRequest,
    ) {
      // No checkout to follow (the thread, its project or its folder is gone, or it is a
      // chat): a remote refresh held back for it can never be delivered either.
      const noCheckout = () => {
        remoteOwed.delete(threadId);
      };
      const thread = Option.getOrUndefined(yield* deps.snapshots.getThreadShellById(threadId));
      if (thread === undefined) return noCheckout();
      const project = yield* readProject(thread.projectId);
      // Chats live in Ryco-managed folders: never a checkout to follow.
      if (project === undefined || isChatProject(project)) return noCheckout();
      const checkout = resolveThreadWorkspaceCwd({ thread, projects: [project] });
      if (checkout === undefined) return noCheckout();
      // A worktree thread's checkout is a worktree: its `.git` is at its own root.
      const location = yield* locateCheckoutHead(checkout, {
        ownGitOnly: thread.worktreePath !== null,
      });
      if (location._tag === "none") return noCheckout();
      const canonicalCheckout = canonicalizeFilesystemPath(checkout);
      // The repository the checkout belongs to: a subfolder project shares its root's HEAD.
      const { root } = location;

      // A provider signal counts only when its command finished in this checkout's repository.
      const signalled = countedSignalEffect(queued.signals, (cwd) =>
        // A relative directory names no place: it counts, like a command's text.
        path.isAbsolute(cwd) ? isWithin(canonicalizeFilesystemPath(cwd), root) : true,
      );
      const command = mergeVcsCommandEffects(queued.command, signalled);
      if (command === null && isCommandOnlyRequest(queued)) {
        // Only signals, all from elsewhere: nothing to read, nothing to refresh.
        yield* Effect.logDebug("thread git sync ignored a signal from another directory", {
          threadId,
          directories: [...(queued.signals?.keys() ?? [])],
        });
        return;
      }
      const request: ThreadGitSyncRequest =
        command === queued.command ? queued : { ...queued, command };

      // A held-back remote refresh alone follows no branch.
      const followsBranch =
        request.turnStart || request.command !== null || request.turnEnd !== null;
      let adopted = false;
      let localRefreshed = false;
      if (followsBranch) {
        let observedBranch: string | null | undefined;
        if (location._tag === "head") {
          observedBranch = location.branch;
        } else {
          // git reads what the file read cannot; the read publishes, so it is also the local refresh.
          const status = yield* inBackgroundProcessLane(
            deps.vcsStatus.refreshLocalStatus(checkout),
          ).pipe(
            Effect.map(Option.some),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.succeed(Option.none()),
            ),
          );
          localRefreshed = Option.isSome(status);
          observedBranch =
            Option.isSome(status) && status.value.isRepo ? status.value.refName : undefined;
        }

        const worktree = yield* readOwnWorktreeRecord(thread);
        const settings = yield* deps.settings.getSettings;
        const candidate = decideThreadBranchAdoption({
          threadBranch: thread.branch,
          worktree,
          observedBranch,
          worktreeBranchPrefix: resolveProjectPreferences({ settings, project })
            .worktreeBranchPrefix.value,
        });
        if (candidate._tag === "adopt") {
          // The window HEAD may have moved in: the ended turn and the one running now.
          const ended = request.turnEnd?.overlap ?? null;
          const running = ownership.current(threadId);
          const overlap =
            ended !== null && running !== null
              ? combineTurnOverlaps(ended, running)
              : (ended ?? running ?? UNTRACKED_TURN);
          const shared = yield* sharesCheckout({
            threadId,
            thread,
            overlap,
            root,
            checkout: canonicalCheckout,
            project,
          });
          if (shared) {
            yield* Effect.logDebug("thread branch follow skipped a shared checkout", {
              threadId,
              branch: candidate.branch,
            });
          } else {
            adopted = yield* adopt({
              threadId,
              thread,
              worktree,
              decision: candidate,
              trigger: request.turnEnd
                ? request.turnEnd.aborted
                  ? "turn-stopped"
                  : "turn-end"
                : queued.command
                  ? "command"
                  : request.command
                    ? "signal"
                    : "turn-start",
            });
          }
        }
      }

      yield* refreshAfterSync({
        threadId,
        checkout,
        canonicalCheckout,
        request,
        adopted,
        localRefreshed,
      });
    });

    const processThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const peeked = pending.get(threadId);
        if (peeked !== undefined && isCommandOnlyRequest(peeked)) {
          yield* Effect.sleep(Duration.millis(settleMs));
        }
        const request = pending.get(threadId);
        pending.delete(threadId);
        queued.delete(threadId);
        if (request === undefined) return;
        // A held-back remote refresh that a turn's end already delivered.
        if (
          request.remoteDue &&
          !remoteOwed.has(threadId) &&
          !request.turnStart &&
          request.command === null &&
          request.signals === null &&
          request.turnEnd === null
        ) {
          return;
        }
        const finished = yield* syncThread(threadId, request).pipe(
          Effect.timeoutOption(syncTimeout),
        );
        if (Option.isNone(finished)) {
          yield* Effect.logWarning("thread git sync timed out", {
            threadId,
            timeoutMs: Duration.toMillis(syncTimeout),
          });
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("thread git sync failed", { threadId, cause: Cause.pretty(cause) }),
        ),
      );

    const worker = yield* makeKeyedSerialWorker({
      policy: losslessBackpressureQueuePolicy({
        component: "ThreadGitMetadataReactor",
        capacity: WORKER_CAPACITY,
      }),
      process: (threadId: ThreadId, _item: undefined) => processThread(threadId),
    });

    function request(threadId: ThreadId, next: ThreadGitSyncRequest): Effect.Effect<void> {
      pending.set(threadId, mergeThreadGitSyncRequests(pending.get(threadId), next));
      if (queued.has(threadId)) return Effect.void;
      queued.add(threadId);
      return worker.enqueue(threadId, undefined);
    }

    const offer: ThreadGitMetadataRuntime["offer"] = (event) => {
      const trigger = gitSyncTriggerFor(event);
      if (trigger === null) return Effect.void;
      const threadId = event.threadId;
      switch (trigger.kind) {
        case "turn-start":
          ownership.start(threadId, trigger.turnId);
          return request(threadId, { ...EMPTY_SYNC_REQUEST, turnStart: true });
        case "command":
          // A signal's directory is checked in the lane: resolving it touches the disk.
          return request(
            threadId,
            trigger.cwd === undefined
              ? { ...EMPTY_SYNC_REQUEST, command: trigger.effect }
              : { ...EMPTY_SYNC_REQUEST, signals: new Map([[trigger.cwd, trigger.effect]]) },
          );
        case "turn-end": {
          // A late or stray end of another turn neither ends ownership nor syncs.
          const overlap = ownership.end(threadId, trigger.turnId);
          if (overlap === null) return Effect.void;
          return request(threadId, {
            ...EMPTY_SYNC_REQUEST,
            turnEnd: { overlap, aborted: trigger.aborted },
          });
        }
        case "session-exit": {
          // An idle session exiting (reaping, reload, shutdown) changed nothing.
          const overlap = ownership.endSession(threadId);
          if (overlap === null) return Effect.void;
          return request(threadId, { ...EMPTY_SYNC_REQUEST, turnEnd: { overlap, aborted: true } });
        }
      }
    };

    return { offer, drain: worker.drain } satisfies ThreadGitMetadataRuntime;
  });
