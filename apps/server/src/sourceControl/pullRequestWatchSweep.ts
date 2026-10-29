/**
 * The server's pull request watch at work: the sweep that reads watched pull requests, the
 * re-check of wakes a busy thread holds, delivery confirmation, and starting or changing a watch.
 * Loaded through `import()` by `PullRequestWatchService` once commands are admitted (or on the
 * first `setWatch`), so none of it, nor the shared decision rules, is on the boot path.
 *
 * Per pass and watched pull request (one group per project and pull request, so one project's
 * unreadable checkout never ends another's watches):
 *
 * 1. GitHub's one-point fingerprint first; the detail and the activity (with the tails of long
 *    review threads) only when the read planner says they could show something new.
 * 2. Every watching thread decides on its own view of the read (`decidePullRequestWatch`), behind
 *    the shared server wake fence, and the decision goes out as one revision-fenced
 *    `thread.pull-request-watch.update` that records the progress and, when there is news,
 *    starts the wake turn in the same transaction.
 * 3. A wake the thread holds (busy, usage-limited, snoozed, ...) is re-checked from the cached
 *    read every 10 s, or at once when the thread's events say it may be free, never with a host
 *    read; a read a decision asks for (the Auto-fix CI no-push grace ended) is scheduled.
 *
 * The forge read memory (fingerprints, cached reads, failure counts, rate-limit pauses, held
 * sightings) is process memory: a restart costs one full read per watched pull request.
 *
 * @module pullRequestWatchSweep
 */
import type {
  ChangeRequestActivity,
  ChangeRequestReviewThread,
  MessageId,
  OrchestrationEvent,
  OrchestrationThreadShell,
  ProjectId,
  PullRequestWatchError,
  SourceControlChangeRequestDetail,
  SourceControlSetPullRequestWatchResult,
  ThreadId,
  ThreadPullRequestWatch,
  ThreadPullRequestWatchUpdateCommand,
  Worktree,
  WorktreeId,
  WorktreePullRequestLink,
} from "@ryco/contracts";
import { makeKeyedSerialExecutor } from "@ryco/shared/KeyedSerialExecutor";
import {
  changePullRequestWatch,
  decidePullRequestWatch,
  describePullRequestWatchNow,
  PULL_REQUEST_WATCH_LIMITS,
  planPullRequestWatchRead,
  pullRequestAutoFixMayFire,
  pullRequestWatchMemberKey,
  recordPullRequestWatchRead,
  settlePullRequestWatchDelivery,
  startPullRequestWatch,
  type PullRequestAutoFixCheckout,
  type PullRequestWatchDecision,
  type PullRequestWatchFingerprint,
  type PullRequestWatchLastRead,
  type PullRequestWatchRead,
  type PullRequestWatchReadPlan,
  type PullRequestWatchThreadState,
  type PullRequestWatchWake,
  type PullRequestWatchWakeStart,
  type ServerWakeHoldReason,
} from "@ryco/shared/pullRequestWatch";
import { summarizePullRequestWatch } from "@ryco/shared/pullRequestWatchSummary";
import type { threadUserAnchorTimestamp } from "@ryco/shared/threadSettlement";
import type { isThreadSnoozed } from "@ryco/shared/threadSnooze";
import type {
  readWorktreePullRequestLinks,
  resolveThreadPullRequestLink,
} from "@ryco/shared/worktreePullRequests";
import { Clock, DateTime, Duration, Effect, Latch, Option, Stream } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

// Boot-path modules (shared ones included) are type-only imports here: the thin service layer hands their services
// and helpers over (`PullRequestWatchRuntimeDeps`). A value import would make the bundler move
// them, and everything they import, into chunks shared with this one, which every boot then
// loads through extra import glue.
import type { AgentControlPolicyShape } from "../agentControl/Services/AgentControlPolicy.ts";
import type { logOnceEvery } from "../logOnceEvery.ts";
import type {
  makePullRequestWatchRejections,
  pullRequestWatchUpdateCommandId,
  pullRequestWatchWakeMessageId,
} from "../orchestration/pullRequestWatchUpdates.ts";
import type { serverWakeGuard, serverWakeInScope } from "../orchestration/serverWake.ts";
import type { OrchestrationCommandApplicationShape } from "../orchestration/Services/OrchestrationCommandApplication.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ServerWakeFenceShape } from "../orchestration/Services/ServerWakeFence.ts";
import type { isThreadWaitWakeEvent } from "../orchestration/threadWaitWakeEvents.ts";
import type { ProjectionThreadPullRequestWatchRepositoryShape } from "../persistence/Services/ProjectionThreadPullRequestWatches.ts";
import type { ProjectionWorktreeRepositoryShape } from "../persistence/Services/ProjectionWorktrees.ts";
import { readWakeStartFailureDelivery } from "../persistence/wakeStartDelivery.ts";
import type { inBackgroundProcessLane } from "../processGovernor.ts";
import type { readCheckoutHead } from "../vcs/gitCheckoutHead.ts";
import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import type {
  changeRequestNumberFromUrl,
  changeRequestRepositoryKey,
} from "./changeRequestRepositoryKey.ts";
import type { PullRequestLinkUpdate } from "./manualPullRequestLink.ts";
import {
  pagedReviewThreadIds,
  pullRequestWatchObservation,
  withReviewThreadTails,
} from "./pullRequestWatchObservation.ts";
import type { PullRequestWatchSetInput } from "./PullRequestWatchService.ts";
import type { RefreshWorktreeSourceControlStateInput } from "./refreshWorktreeSourceControlState.ts";
import type { SourceControlProviderShape } from "./SourceControlProvider.ts";
import type { SourceControlProviderRegistryShape } from "./SourceControlProviderRegistry.ts";

const LIMITS = PULL_REQUEST_WATCH_LIMITS;

/** Review threads a single activity read fetches the rest of; longer conversations stay unread whole. */
export const PULL_REQUEST_WATCH_TAIL_READS_MAX = 10;
/** A woken re-check of held wakes runs at most this often (thread events can come in bursts). */
const HELD_RECHECK_MIN_SPACING_MS = 1_000;
/** Thread events that can free a held wake beyond the ones Agent Control waits wake on. */
const HELD_WAKE_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set<
  OrchestrationEvent["type"]
>([
  "thread.usage-limit-cleared",
  "thread.unsnoozed",
  "thread.interaction-mode-set",
  "thread.runtime-mode-set",
]);
const MAIN_CHECKOUT_DETAIL =
  "This chat works in the project's main checkout, which links no pull request on its own. Name the pull request (its number or URL) to watch it.";

/** What the watch runs on, handed over by the thin boot layer (`PullRequestWatchService.ts`). */
export interface PullRequestWatchRuntimeDeps {
  readonly commands: OrchestrationCommandApplicationShape;
  readonly engine: OrchestrationEngineShape;
  readonly projections: ProjectionSnapshotQueryShape;
  readonly watchRows: ProjectionThreadPullRequestWatchRepositoryShape;
  readonly worktrees: ProjectionWorktreeRepositoryShape;
  readonly registry: SourceControlProviderRegistryShape;
  readonly fence: ServerWakeFenceShape;
  readonly git: GitVcsDriverShape;
  readonly sql: SqlClient.SqlClient;
  /** Agent-started news holds while Agent Control is off; absent = on. */
  readonly policy: AgentControlPolicyShape | undefined;
  /** Boot-path helpers (see the import note above). */
  readonly helpers: {
    /** Refresh a workspace's links (or discover its branch's pull request); never fails. */
    readonly refreshWorkspace: (
      input: RefreshWorktreeSourceControlStateInput,
    ) => Effect.Effect<void>;
    /** The pull request the checkout's branch has now (its ref summary). */
    readonly discoverPullRequest: NonNullable<
      RefreshWorktreeSourceControlStateInput["discoverPullRequest"]
    >;
    /**
     * Link a named pull request to a workspace by hand, after the repository check; `dispatch`
     * writes the link (the watch keeps it to write once the watch goes through).
     */
    readonly linkPullRequest: (input: {
      readonly worktree: Worktree;
      readonly cwd: string;
      readonly reference: string;
      readonly operation: string;
      readonly dispatch: (
        update: PullRequestLinkUpdate,
      ) => Effect.Effect<void, PullRequestLinkError>;
    }) => Effect.Effect<WorktreePullRequestLink, PullRequestLinkError>;
    /** `linkPullRequest` refused another repository's pull request (or could not tell). */
    readonly isWrongRepositoryLinkFailure: (error: PullRequestLinkError) => boolean;
    readonly readCheckoutHead: typeof readCheckoutHead;
    readonly logOnceEvery: typeof logOnceEvery;
    readonly inBackgroundLane: typeof inBackgroundProcessLane;
    readonly isThreadWaitWakeEvent: typeof isThreadWaitWakeEvent;
    readonly serverWakeGuard: typeof serverWakeGuard;
    readonly serverWakeInScope: typeof serverWakeInScope;
    readonly updateCommandId: typeof pullRequestWatchUpdateCommandId;
    readonly wakeMessageId: typeof pullRequestWatchWakeMessageId;
    readonly makeRejections: typeof makePullRequestWatchRejections;
    readonly repositoryKey: typeof changeRequestRepositoryKey;
    readonly numberFromUrl: typeof changeRequestNumberFromUrl;
    /** Records links on a workspace (`worktree.pull-requests.update`). */
    readonly dispatchLinks: (
      update: PullRequestLinkUpdate,
    ) => Effect.Effect<void, PullRequestLinkError>;
    readonly watchError: (
      reason: PullRequestWatchError["reason"],
      detail: string,
    ) => PullRequestWatchError;
    readonly readWorktreePullRequestLinks: typeof readWorktreePullRequestLinks;
    readonly resolveThreadPullRequestLink: typeof resolveThreadPullRequestLink;
    readonly threadUserAnchorTimestamp: typeof threadUserAnchorTimestamp;
    readonly isThreadSnoozed: typeof isThreadSnoozed;
  };
}

/** The error a manual link fails with (`SourceControlProviderError`). */
export type PullRequestLinkError = import("@ryco/contracts").SourceControlProviderError;

export type PullRequestWatchSetRequest = PullRequestWatchSetInput;

export interface PullRequestWatchRuntime {
  readonly setWatch: (
    input: PullRequestWatchSetRequest,
  ) => Effect.Effect<SourceControlSetPullRequestWatchResult, PullRequestWatchError>;
  /** One full pass now (tests, the measurement script). */
  readonly sweep: Effect.Effect<void>;
  /**
   * Held wakes and pending deliveries decided again from the cached reads, with no host read
   * (what the loop runs every 10 s and when a held thread's events say it may be free).
   */
  readonly recheck: Effect.Effect<void>;
  /** Sweeps every 2 minutes and re-checks held wakes until interrupted. */
  readonly run: Effect.Effect<never>;
}

// ── Forge read failures ───────────────────────────────────────────────

export type PullRequestWatchReadFailure =
  | { readonly kind: "rate-limited"; readonly retryAtMs: number | null }
  | { readonly kind: "failed" };

const retryAtMsOf = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value);
  return null;
};

/**
 * A rate limit pauses a watched pull request's reads (until the host's reset when it says) and
 * is never a read failure. Reads the typed reason a provider error may carry, else the detail
 * text every GitHub read normalizes a rate limit to.
 */
export function classifyPullRequestWatchReadFailure(error: unknown): PullRequestWatchReadFailure {
  if (typeof error === "object" && error !== null) {
    if ("reason" in error && error.reason === "rate-limited") {
      return {
        kind: "rate-limited",
        retryAtMs: "retryAt" in error ? retryAtMsOf(error.retryAt) : null,
      };
    }
    const detail = "detail" in error && typeof error.detail === "string" ? error.detail : "";
    if (/rate limit/iu.test(detail)) return { kind: "rate-limited", retryAtMs: null };
  }
  return { kind: "failed" };
}

interface WatchReadError {
  readonly _tag: "PullRequestWatchReadError";
  readonly failure: PullRequestWatchReadFailure;
  readonly error: unknown;
}

const watchReadError = (error: unknown): WatchReadError => ({
  _tag: "PullRequestWatchReadError",
  failure: classifyPullRequestWatchReadFailure(error),
  error,
});

const asWatchRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(watchReadError));

// ── Small pure helpers ────────────────────────────────────────────────

const iso = (ms: number) => new Date(ms).toISOString();

const groupKeyOf = (projectId: string, watchId: string) => `${projectId} ${watchId}`;

const usableWorkspace = (worktree: Worktree) =>
  worktree.archivedAt === null && !worktree.checkoutRemovedAt;

/** What the no-fingerprint path re-reads on: the workspace link's own state moving. */
const linkSnapshot = (link: WorktreePullRequestLink) =>
  JSON.stringify([link.state, link.isDraft, link.terminalAt, link.headRefName, link.baseRefName]);

const terminalAtOf = (detail: SourceControlChangeRequestDetail): string | null => {
  const at = detail.mergedAt ?? detail.closedAt;
  return at === undefined ? null : DateTime.formatIso(at);
};

/** The decider's refusal text, or null for a failure that is not a refusal (storage, admission). */
const refusalDetail = (error: unknown): string | null => {
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  return typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "OrchestrationCommandInvariantError" &&
    "detail" in cause &&
    typeof cause.detail === "string"
    ? cause.detail
    : null;
};

/** What a change answers that read nothing from the host: the watch as the change left it. */
const watchingLine = (watch: ThreadPullRequestWatch) =>
  `Watching #${watch.number}: news ${watch.news ? "on" : "off"}, Auto-fix CI ${
    watch.autoFix === null ? "off" : watch.autoFix.status === "paused" ? "paused" : "on"
  }.`;

/** The pull request a `setWatch` request names; both absent for the thread's own. */
interface RequestedPullRequest {
  readonly number: number | undefined;
  /** The named URL's repository key; null without a URL. */
  readonly urlKey: string | null;
}

/** One read of a group's pull request, shared by every watching thread. */
interface GroupRead {
  readonly detail: SourceControlChangeRequestDetail;
  /** The last activity read; null before the first one. */
  readonly activity: ChangeRequestActivity | null;
  readonly observedAtMs: number;
}

interface Member {
  readonly threadId: ThreadId;
  readonly watch: ThreadPullRequestWatch;
}

interface Group {
  readonly key: string;
  readonly projectId: ProjectId;
  readonly watchId: string;
  readonly number: number;
  readonly url: string;
  readonly members: Member[];
  /** The workspaces that link it, in member order (the first usable checkout is read). */
  readonly worktrees: Worktree[];
  readonly snapshot: string;
}

const observedRead = (read: GroupRead, watch: ThreadPullRequestWatch): PullRequestWatchRead => ({
  kind: "observed",
  observation: pullRequestWatchObservation({
    detail: read.detail,
    activity: read.activity,
    remarksThrough: watch.remarksThrough,
    observedAtMs: read.observedAtMs,
  }),
});

// ── The runtime ───────────────────────────────────────────────────────

export const makePullRequestWatchRuntime = (
  deps: PullRequestWatchRuntimeDeps,
): Effect.Effect<PullRequestWatchRuntime> =>
  Effect.gen(function* () {
    const {
      commands,
      engine,
      projections,
      watchRows,
      worktrees,
      registry,
      fence,
      git,
      sql,
      policy,
      helpers,
    } = deps;

    const serial = yield* makeKeyedSerialExecutor<ThreadId>();
    /** Per pull request (`watchId`): who may turn Auto-fix CI on, taken inside a thread's lock. */
    const autoFixOwners = yield* makeKeyedSerialExecutor<string>();
    const rejections = helpers.makeRejections();

    // Process memory (see the module comment).
    const lastRead = new Map<string, PullRequestWatchLastRead>();
    const cachedRead = new Map<string, GroupRead>();
    const readFailures = new Map<string, number>();
    const pausedUntilMs = new Map<string, number>();
    /** Group reads a decision asked for, by when they are due. */
    const readAfterMs = new Map<string, number>();
    /** First sighting of a held wake, per watch generation. */
    const heldSinceMs = new Map<string, number>();
    /** Watches whose wake is held or whose delivery is pending: thread → watch → group key. */
    const heldMembers = new Map<ThreadId, Map<string, string>>();

    const memberHoldKey = (threadId: ThreadId, watch: ThreadPullRequestWatch) =>
      `${threadId}\u0000${watch.watchId}\u0000${watch.startedAt}`;

    const markHeld = (threadId: ThreadId, watchId: string, groupKey: string) => {
      const watches = heldMembers.get(threadId) ?? new Map<string, string>();
      watches.set(watchId, groupKey);
      heldMembers.set(threadId, watches);
    };
    const unmarkHeld = (threadId: ThreadId, watchId: string) => {
      const watches = heldMembers.get(threadId);
      if (watches === undefined) return;
      watches.delete(watchId);
      if (watches.size === 0) heldMembers.delete(threadId);
    };

    /** The watch's id: one per pull request, whichever thread watches it. */
    const watchIdOf = (url: string, number: number): string | null => {
      const repository = helpers.repositoryKey(url);
      return repository === null ? null : `${repository}#${number}`;
    };

    const watchError = helpers.watchError;

    const visibleLink = (worktree: Worktree, number: number): WorktreePullRequestLink | undefined =>
      helpers
        .readWorktreePullRequestLinks(worktree)
        .find((link) => link.number === number && !link.dismissedAt);

    const logWatch = (
      key: string,
      message: string,
      fields: Record<string, unknown>,
      cause?: unknown,
    ) =>
      helpers.logOnceEvery({
        key: `pullRequestWatch.${key}`,
        message,
        fields,
        ...(cause === undefined ? {} : { cause }),
      });

    // ── Reads of the projection ──────────────────────────────────────

    const currentWatch = (threadId: ThreadId, watchId: string) =>
      watchRows
        .getByThreadId({ threadId })
        .pipe(
          Effect.map((row) =>
            Option.isSome(row)
              ? (row.value.watches.active.find((watch) => watch.watchId === watchId) ?? null)
              : null,
          ),
        );

    const threadShell = (threadId: ThreadId) =>
      projections.getThreadShellById(threadId).pipe(Effect.map((shell) => Option.getOrNull(shell)));

    const projectRoot = (projectId: ProjectId) =>
      projections
        .getProjectShellById(projectId)
        .pipe(
          Effect.map((project) =>
            Option.isSome(project) ? project.value.workspaceRoot : (null as string | null),
          ),
        );

    /** A workspace's checkout, or the project root for the main workspace (or a removed checkout). */
    const workspaceCwd = (worktree: Worktree) =>
      worktree.worktreePath !== null && !worktree.checkoutRemovedAt
        ? Effect.succeed<string | null>(worktree.worktreePath)
        : projectRoot(worktree.projectId);

    /** The checkout a thread works in: its own, else the project root. */
    const threadCwd = (shell: OrchestrationThreadShell) =>
      shell.worktreePath !== null
        ? Effect.succeed<string | null>(shell.worktreePath)
        : projectRoot(shell.projectId);

    // ── The thread's side ───────────────────────────────────────────

    /** How the turn start of a pending wake ended (M6: only a proven not-sent rolls progress back). */
    const wakeStart = (threadId: ThreadId, messageId: MessageId) =>
      Effect.gen(function* () {
        const state = yield* fence.wakeStartState(threadId, messageId);
        const start: PullRequestWatchWakeStart =
          state === "failed"
            ? yield* readWakeStartFailureDelivery(sql, { threadId, messageId })
            : state;
        return start;
      });

    const threadState = (
      watch: ThreadPullRequestWatch,
      shell: OrchestrationThreadShell,
      nowMs: number,
    ) =>
      Effect.gen(function* () {
        let hold: ServerWakeHoldReason | null = yield* fence.holdReason(shell, nowMs);
        if (hold === null && (yield* fence.reverting(shell.id, nowMs))) hold = "reverting";
        if (hold === null) {
          const cold = yield* fence.coldStart(shell.id, nowMs);
          if (cold.cold && cold.budgetFull) hold = "cold-budget";
        }
        const agentControlEnabled = policy === undefined ? true : yield* policy.isEnabled;
        return {
          hold,
          heldSinceMs: heldSinceMs.get(memberHoldKey(shell.id, watch)) ?? null,
          interactionMode: shell.interactionMode,
          planReady: shell.hasActionableProposedPlan,
          snoozed: helpers.isThreadSnoozed(shell, nowMs),
          agentControlEnabled,
          latestTurn:
            shell.latestTurn === null
              ? null
              : {
                  requestedAt: shell.latestTurn.requestedAt,
                  completedAt: shell.latestTurn.completedAt,
                  state: shell.latestTurn.state,
                },
          inScope: helpers.serverWakeInScope(watch, shell),
        } satisfies PullRequestWatchThreadState;
      });

    /** The checkout Auto-fix CI would edit: branch from disk, local status only, HEAD. */
    const readCheckout = (shell: OrchestrationThreadShell) =>
      Effect.gen(function* () {
        const cwd = yield* threadCwd(shell);
        if (cwd === null) return null;
        const head = yield* helpers.readCheckoutHead(cwd);
        const status = yield* git.statusDetailsLocal(cwd);
        const rev = yield* git.execute({
          operation: "pullRequestWatch.checkoutHead",
          cwd,
          args: ["rev-parse", "HEAD"],
          readOnly: true,
        });
        const headSha = rev.stdout.trim();
        if (headSha.length === 0) return null;
        return {
          branch: head?.branch ?? status.branch,
          clean: !status.hasWorkingTreeChanges,
          headSha,
        } satisfies PullRequestAutoFixCheckout;
      }).pipe(
        helpers.inBackgroundLane,
        Effect.catchCause((cause) =>
          logWatch(
            `checkout:${shell.id}`,
            "Pull request watch could not read the checkout",
            {
              threadId: shell.id,
            },
            cause,
          ).pipe(Effect.as(null)),
        ),
      );

    // ── Dispatch ────────────────────────────────────────────────────

    type UpdateOutcome = "accepted" | "refused" | "failed";

    const generationOf = (threadId: ThreadId, watch: ThreadPullRequestWatch) => ({
      threadId,
      watchId: watch.watchId,
      startedAt: watch.startedAt,
    });

    const forgetMember = (threadId: ThreadId, watch: ThreadPullRequestWatch) => {
      rejections.forget(generationOf(threadId, watch));
      heldSinceMs.delete(memberHoldKey(threadId, watch));
      unmarkHeld(threadId, watch.watchId);
    };

    /** One revision-fenced change of `watch`; a refusal with a wake counts toward `rejected`. */
    const applyUpdate = (input: {
      readonly threadId: ThreadId;
      readonly watch: ThreadPullRequestWatch;
      readonly next: ThreadPullRequestWatch | null;
      readonly endReason?: ThreadPullRequestWatchUpdateCommand["endReason"];
      readonly wake?: ThreadPullRequestWatchUpdateCommand["wake"];
      readonly createdAt: string;
    }): Effect.Effect<UpdateOutcome> => {
      const { threadId, watch } = input;
      const command: ThreadPullRequestWatchUpdateCommand = {
        type: "thread.pull-request-watch.update",
        commandId: helpers.updateCommandId({
          threadId,
          watchId: watch.watchId,
          revision: watch.revision,
        }),
        threadId,
        watchId: watch.watchId,
        expectedRevision: watch.revision,
        expectedStartedAt: watch.startedAt,
        next: input.next,
        ...(input.endReason === undefined ? {} : { endReason: input.endReason }),
        ...(input.wake === undefined ? {} : { wake: input.wake }),
        createdAt: input.createdAt,
      };
      return commands.applyInternal(command).pipe(
        Effect.as("accepted" as const),
        Effect.tap(() =>
          Effect.sync(() => {
            if (input.next === null) forgetMember(threadId, watch);
            else rejections.noteAccepted(generationOf(threadId, watch));
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const detail = refusalDetail(error);
            if (detail === null) {
              yield* logWatch(
                `dispatch:${threadId}:${watch.watchId}`,
                "Pull request watch update failed; it is retried on the next pass",
                { threadId, watchId: watch.watchId },
                error,
              );
              return "failed" as const;
            }
            yield* logWatch(
              `refused:${threadId}:${watch.watchId}:${detail}`,
              "Pull request watch update was refused",
              { threadId, watchId: watch.watchId, detail },
            );
            const exhausted =
              input.wake !== undefined &&
              rejections.noteRefused(generationOf(threadId, watch), detail);
            if (exhausted) {
              // Its updates keep being refused (a lifecycle the decider will not lift): stop.
              yield* applyUpdate({
                threadId,
                watch,
                next: null,
                endReason: "rejected",
                createdAt: iso(yield* Clock.currentTimeMillis),
              });
            }
            return "refused" as const;
          }),
        ),
      );
    };

    /**
     * An update that starts a wake turn: the cold-start budget slot first (atomic across every
     * wake source), the decider's guard pinned to the shell the decision read.
     */
    const applyWake = (input: {
      readonly threadId: ThreadId;
      readonly shell: OrchestrationThreadShell;
      readonly watch: ThreadPullRequestWatch;
      readonly next: ThreadPullRequestWatch | null;
      readonly endReason?: ThreadPullRequestWatchUpdateCommand["endReason"];
      readonly wake: PullRequestWatchWake;
      readonly messageId: MessageId;
      readonly createdAt: string;
      readonly nowMs: number;
    }) =>
      Effect.gen(function* () {
        const { threadId, messageId, nowMs } = input;
        const cold = yield* fence.coldStart(threadId, nowMs);
        if (cold.cold && !(yield* fence.reserveColdSlot(threadId, messageId, nowMs))) {
          return "held" as const;
        }
        const outcome = yield* Effect.gen(function* () {
          const latestUserMessageId = yield* fence.latestUserMessageId(threadId);
          return yield* applyUpdate({
            threadId,
            watch: input.watch,
            next: input.next,
            ...(input.endReason === undefined ? {} : { endReason: input.endReason }),
            wake: {
              messageId,
              text: input.wake.text,
              guard: helpers.serverWakeGuard(
                input.shell,
                latestUserMessageId,
                "pull-request-watch",
              ),
            },
            createdAt: input.createdAt,
          });
        }).pipe(
          Effect.onExit((exit) =>
            !cold.cold
              ? Effect.void
              : exit._tag === "Success" && exit.value === "accepted"
                ? fence.noteColdWake(threadId, messageId, nowMs)
                : fence.releaseColdSlot(threadId, messageId),
          ),
        );
        return outcome;
      });

    // ── One watch's decision ─────────────────────────────────────────

    /**
     * Decide one thread's watch on `readFor(watch)` and dispatch the result. Serialised per
     * thread with `setWatch`; the decider's revision and generation fence covers the rest.
     */
    const decideMember = (
      threadId: ThreadId,
      watchId: string,
      groupKey: string,
      readFor: (watch: ThreadPullRequestWatch) => PullRequestWatchRead,
    ) =>
      serial
        .withLock(
          threadId,
          Effect.gen(function* () {
            let watch = yield* currentWatch(threadId, watchId);
            if (watch === null) {
              unmarkHeld(threadId, watchId);
              return;
            }
            let shell = yield* threadShell(threadId);
            if (shell === null) return;
            const startedMs = yield* Clock.currentTimeMillis;

            // The previous wake's turn start: bound, provably never sent (its news is re-derived),
            // or lost or uncertain (left as it is; a fix turn that did not start pauses Auto-fix CI).
            if (watch.delivery !== null) {
              const start = yield* wakeStart(threadId, watch.delivery.messageId);
              const settled = settlePullRequestWatchDelivery(watch, start, iso(startedMs));
              if (settled !== null) {
                if (
                  (yield* applyUpdate({
                    threadId,
                    watch,
                    next: settled,
                    createdAt: iso(startedMs),
                  })) !== "accepted"
                ) {
                  return;
                }
                watch = settled;
              }
            }

            const read = readFor(watch);
            let thread = yield* threadState(watch, shell, startedMs);
            let checkout: PullRequestAutoFixCheckout | null = null;
            if (
              read.kind === "observed" &&
              pullRequestAutoFixMayFire(watch, read.observation, thread)
            ) {
              checkout = yield* readCheckout(shell);
              // The thread may have taken a turn during the git reads (Synara re-checks busy).
              shell = yield* threadShell(threadId);
              if (shell === null) return;
              thread = yield* threadState(watch, shell, yield* Clock.currentTimeMillis);
            }

            const nowMs = yield* Clock.currentTimeMillis;
            const nowIso = iso(nowMs);
            const messageId = helpers.wakeMessageId(threadId);
            const decision = decidePullRequestWatch({
              watch,
              read,
              thread,
              checkout,
              messageId,
              nowIso,
            });
            yield* applyDecision({ threadId, watch, decision, shell, messageId, nowMs, groupKey });
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            logWatch(
              `decide:${threadId}:${watchId}`,
              "Pull request watch pass failed for a chat",
              {
                threadId,
                watchId,
              },
              cause,
            ),
          ),
        );

    const applyDecision = (input: {
      readonly threadId: ThreadId;
      readonly watch: ThreadPullRequestWatch;
      readonly decision: PullRequestWatchDecision;
      readonly shell: OrchestrationThreadShell;
      readonly messageId: MessageId;
      readonly nowMs: number;
      readonly groupKey: string;
    }) =>
      Effect.gen(function* () {
        const { threadId, watch, decision, nowMs, groupKey } = input;
        const holdKey = memberHoldKey(threadId, watch);
        const createdAt = iso(nowMs);
        const settleHeldState = (next: ThreadPullRequestWatch | null) => {
          if (next !== null && next.delivery !== null) markHeld(threadId, watch.watchId, groupKey);
          else unmarkHeld(threadId, watch.watchId);
        };
        switch (decision.type) {
          case "wait": {
            if (decision.held) {
              if (!heldSinceMs.has(holdKey)) heldSinceMs.set(holdKey, nowMs);
              markHeld(threadId, watch.watchId, groupKey);
            } else {
              heldSinceMs.delete(holdKey);
              settleHeldState(watch);
            }
            if (decision.readAfterMs !== null) {
              // Never before a rate-limit pause ends: a paused group answers from its cache, so
              // an earlier read would ask again at once.
              const at = Math.max(decision.readAfterMs, pausedUntilMs.get(groupKey) ?? 0);
              const due = readAfterMs.get(groupKey);
              readAfterMs.set(groupKey, due === undefined ? at : Math.min(due, at));
            }
            return;
          }
          case "record": {
            if (
              (yield* applyUpdate({ threadId, watch, next: decision.next, createdAt })) ===
              "accepted"
            ) {
              heldSinceMs.delete(holdKey);
              settleHeldState(decision.next);
            }
            return;
          }
          case "wake": {
            const outcome = yield* applyWake({
              threadId,
              shell: input.shell,
              watch,
              next: decision.next,
              wake: decision.wake,
              messageId: input.messageId,
              createdAt,
              nowMs,
            });
            if (outcome === "held") {
              if (!heldSinceMs.has(holdKey)) heldSinceMs.set(holdKey, nowMs);
              markHeld(threadId, watch.watchId, groupKey);
            } else if (outcome === "accepted") {
              heldSinceMs.delete(holdKey);
              settleHeldState(decision.next);
            }
            return;
          }
          case "end": {
            if (decision.wake === null) {
              yield* applyUpdate({
                threadId,
                watch,
                next: null,
                endReason: decision.reason,
                createdAt,
              });
              return;
            }
            const outcome = yield* applyWake({
              threadId,
              shell: input.shell,
              watch,
              next: null,
              endReason: decision.reason,
              wake: decision.wake,
              messageId: input.messageId,
              createdAt,
              nowMs,
            });
            if (outcome === "held") {
              if (!heldSinceMs.has(holdKey)) heldSinceMs.set(holdKey, nowMs);
              markHeld(threadId, watch.watchId, groupKey);
            }
            return;
          }
        }
      });

    /** End a watch without a read (its link is gone, or the workspace already reads merged). */
    const endMember = (member: Member, reason: "unlinked" | "merged") =>
      serial
        .withLock(
          member.threadId,
          Effect.gen(function* () {
            const watch = yield* currentWatch(member.threadId, member.watch.watchId);
            if (watch === null || watch.startedAt !== member.watch.startedAt) return;
            yield* applyUpdate({
              threadId: member.threadId,
              watch,
              next: null,
              endReason: reason,
              createdAt: iso(yield* Clock.currentTimeMillis),
            });
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            logWatch(
              `end:${member.threadId}:${member.watch.watchId}`,
              "Pull request watch could not end",
              {
                threadId: member.threadId,
              },
              cause,
            ),
          ),
        );

    // ── Group reads ─────────────────────────────────────────────────

    const readActivity = (provider: SourceControlProviderShape, cwd: string, number: number) =>
      Effect.gen(function* () {
        if (provider.getChangeRequestActivity === undefined) return null;
        const reference = String(number);
        const activity = yield* asWatchRead(provider.getChangeRequestActivity({ cwd, reference }));
        const paged = pagedReviewThreadIds(activity);
        const readThread = provider.getChangeRequestReviewThread;
        if (paged.length === 0 || readThread === undefined) return activity;
        const tails = new Map<string, ChangeRequestReviewThread>();
        yield* Effect.forEach(
          paged.slice(0, PULL_REQUEST_WATCH_TAIL_READS_MAX),
          (threadId) =>
            readThread({ cwd, reference, threadId }).pipe(
              Effect.tap((thread) =>
                Effect.sync(() => {
                  if (thread !== null) tails.set(threadId, thread);
                }),
              ),
              Effect.asVoid,
              // A thread that cannot be read leaves the conversation not read whole (no remark
              // advance); only a rate limit stops the whole read.
              Effect.catch((error) =>
                classifyPullRequestWatchReadFailure(error).kind === "rate-limited"
                  ? Effect.fail(watchReadError(error))
                  : Effect.void,
              ),
            ),
          { discard: true },
        );
        return withReviewThreadTails(activity, tails);
      });

    type GroupOutcome =
      | { readonly kind: "read"; readonly read: GroupRead; readonly fresh: boolean }
      | { readonly kind: "none" }
      | { readonly kind: "paused" }
      | { readonly kind: "failed"; readonly consecutiveFailures: number };

    const readGroup = (group: Group, options: { readonly forceDetail: boolean }) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const cached = cachedRead.get(group.key);
        const paused = pausedUntilMs.get(group.key);
        if (paused !== undefined && paused > nowMs) {
          return cached === undefined
            ? ({ kind: "paused" } as const)
            : ({ kind: "read", read: cached, fresh: false } as const);
        }
        let cwd: string | null = null;
        for (const worktree of group.worktrees) {
          cwd = yield* asWatchRead(workspaceCwd(worktree));
          if (cwd !== null) break;
        }
        if (cwd === null) {
          return yield* Effect.fail(
            watchReadError(new Error("No checkout or project root can read this pull request.")),
          );
        }
        const provider = yield* asWatchRead(registry.resolve({ cwd }));
        const fingerprint: PullRequestWatchFingerprint | null =
          provider.getChangeRequestWatchFingerprint === undefined
            ? null
            : yield* provider
                .getChangeRequestWatchFingerprint({ cwd, number: group.number, url: group.url })
                .pipe(
                  // A failed fingerprint falls back to the plan without one; a rate limit pauses.
                  Effect.catch((error) =>
                    classifyPullRequestWatchReadFailure(error).kind === "rate-limited"
                      ? Effect.fail(watchReadError(error))
                      : Effect.succeed(null),
                  ),
                );
        const memberKeys = new Set(
          group.members.map((member) => pullRequestWatchMemberKey(member.threadId, member.watch)),
        );
        const last = lastRead.get(group.key);
        let plan: PullRequestWatchReadPlan =
          cached === undefined
            ? { detail: true, activity: true, confirmsCached: false }
            : planPullRequestWatchRead({
                memberKeys,
                snapshot: group.snapshot,
                last,
                fingerprint,
                nowMs,
              });
        // A due read (the no-push grace ended) needs a current answer: the detail, unless a
        // fresh fingerprint already confirms the cached one.
        if (options.forceDetail && !plan.detail && !plan.confirmsCached) {
          plan = { ...plan, detail: true };
        }
        // A current answer (a detail read, or a fingerprint confirming the cache) is the read a
        // due request asked for, so a full sweep does not repeat it; decisions may ask again.
        const answeredDueRead = () => {
          if ((readAfterMs.get(group.key) ?? Number.POSITIVE_INFINITY) <= nowMs) {
            readAfterMs.delete(group.key);
          }
        };
        if (!plan.detail) {
          if (cached === undefined) return { kind: "none" } as const;
          if (plan.confirmsCached) answeredDueRead();
          const read = plan.confirmsCached ? { ...cached, observedAtMs: nowMs } : cached;
          cachedRead.set(group.key, read);
          return { kind: "read", read, fresh: false } as const;
        }
        const detail = yield* asWatchRead(
          provider.getChangeRequestDetail({
            cwd,
            reference: String(group.number),
            fullContent: false,
          }),
        );
        answeredDueRead();
        const activity = plan.activity
          ? yield* readActivity(provider, cwd, group.number)
          : (cached?.activity ?? null);
        const read: GroupRead = { detail, activity, observedAtMs: nowMs };
        cachedRead.set(group.key, read);
        // Complete for the oldest watermark means complete for every member.
        const oldestThrough = group.members
          .map((member) => member.watch.remarksThrough)
          .toSorted()[0]!;
        lastRead.set(
          group.key,
          recordPullRequestWatchRead({
            last,
            plan,
            memberKeys,
            snapshot: group.snapshot,
            fingerprint,
            observation: pullRequestWatchObservation({
              detail,
              activity,
              remarksThrough: oldestThrough,
              observedAtMs: nowMs,
            }),
            nowMs,
          }),
        );
        readFailures.delete(group.key);
        pausedUntilMs.delete(group.key);
        return { kind: "read", read, fresh: true } as const;
      }).pipe(
        Effect.catch((error: WatchReadError) =>
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            if (error.failure.kind === "rate-limited") {
              // Never a failure: wait for the host's reset (or one sweep when it does not say).
              pausedUntilMs.set(
                group.key,
                error.failure.retryAtMs ?? nowMs + LIMITS.sweepIntervalMs,
              );
              yield* logWatch(
                `rateLimited:${group.key}`,
                "Pull request watch paused for a rate limit",
                {
                  watchId: group.watchId,
                },
              );
              const cached = cachedRead.get(group.key);
              return cached === undefined
                ? ({ kind: "paused" } as const)
                : ({ kind: "read", read: cached, fresh: false } as const);
            }
            const consecutiveFailures = (readFailures.get(group.key) ?? 0) + 1;
            readFailures.set(group.key, consecutiveFailures);
            yield* logWatch(
              `read:${group.key}`,
              "Pull request watch could not read a pull request",
              {
                watchId: group.watchId,
                consecutiveFailures,
              },
              error.error,
            );
            return { kind: "failed", consecutiveFailures } as const;
          }),
        ),
      );

    /** After a read saw the pull request merged or closed: the workspace link learns it now. */
    const refreshLinks = (group: Group, detail: SourceControlChangeRequestDetail) =>
      Effect.forEach(
        new Map(group.worktrees.map((worktree) => [worktree.worktreeId, worktree] as const)),
        ([worktreeId, worktree]: readonly [WorktreeId, Worktree]) => {
          const terminalAt = terminalAtOf(detail);
          // The main workspace has no checkout of its own, so a workspace refresh skips it (its
          // links were made by hand): record the state in hand on its link directly.
          if (worktree.worktreePath === null) {
            return helpers
              .dispatchLinks({
                worktreeId,
                upserts: [
                  {
                    number: detail.number,
                    state: detail.state,
                    isDraft: detail.isDraft ?? null,
                    ...(terminalAt === null ? {} : { terminalAt }),
                    source: "manual",
                  },
                ],
              })
              .pipe(
                Effect.catchCause((cause) =>
                  logWatch(
                    `refreshMainLink:${worktreeId}`,
                    "Pull request watch could not record the pull request's end on the main workspace",
                    { worktreeId },
                    cause,
                  ),
                ),
              );
          }
          return helpers.refreshWorkspace({
            worktreeId,
            linkRefreshIntervalMs: 0,
            knownPullRequestStates: () =>
              Effect.succeed(
                new Map([
                  [
                    detail.number,
                    {
                      state: detail.state,
                      isDraft: detail.isDraft ?? false,
                      reported: { terminalAt },
                    },
                  ],
                ]),
              ),
          });
        },
        { discard: true },
      );

    const passGroup = (group: Group, options: { readonly forceDetail: boolean }) =>
      Effect.gen(function* () {
        const outcome: GroupOutcome = yield* readGroup(group, options);
        switch (outcome.kind) {
          case "none":
          case "paused":
            return;
          case "failed":
            yield* Effect.forEach(
              group.members,
              (member) =>
                decideMember(member.threadId, member.watch.watchId, group.key, () => ({
                  kind: "failed",
                  consecutiveFailures: outcome.consecutiveFailures,
                })),
              { discard: true },
            );
            return;
          case "read":
            yield* Effect.forEach(
              group.members,
              (member) =>
                decideMember(member.threadId, member.watch.watchId, group.key, (watch) =>
                  observedRead(outcome.read, watch),
                ),
              { discard: true },
            );
            if (outcome.fresh && outcome.read.detail.state !== "open") {
              yield* refreshLinks(group, outcome.read.detail);
            }
        }
      });

    /** Every active watch, grouped; watches whose link is gone end here without a read. */
    const collectGroups = Effect.gen(function* () {
      const rows = yield* watchRows.listActive();
      const workspaces = new Map<WorktreeId, Worktree | null>();
      const groups = new Map<string, Group>();
      const ends: Array<{ readonly member: Member; readonly reason: "unlinked" | "merged" }> = [];
      for (const row of rows) {
        for (const watch of row.watches.active) {
          const member: Member = { threadId: row.threadId, watch };
          let worktree = workspaces.get(watch.worktreeId);
          if (worktree === undefined) {
            worktree = Option.getOrNull(yield* worktrees.getById({ worktreeId: watch.worktreeId }));
            workspaces.set(watch.worktreeId, worktree);
          }
          const link =
            worktree === null || !usableWorkspace(worktree)
              ? undefined
              : visibleLink(worktree, watch.number);
          if (worktree === null || link === undefined) {
            ends.push({ member, reason: "unlinked" });
            continue;
          }
          // T3 `endsWithoutRead`: the workspace already knows it merged.
          if (link.state === "merged") {
            ends.push({ member, reason: "merged" });
            continue;
          }
          const key = groupKeyOf(worktree.projectId, watch.watchId);
          let group = groups.get(key);
          if (group === undefined) {
            group = {
              key,
              projectId: worktree.projectId,
              watchId: watch.watchId,
              number: watch.number,
              url: watch.url,
              members: [],
              worktrees: [],
              snapshot: linkSnapshot(link),
            };
            groups.set(key, group);
          }
          group.members.push(member);
          if (!group.worktrees.includes(worktree)) group.worktrees.push(worktree);
        }
      }
      return { groups, ends };
    });

    /** Forget read memory of pull requests nobody watches any more. */
    const pruneMemory = (groups: ReadonlyMap<string, Group>) => {
      const liveHolds = new Set<string>();
      for (const group of groups.values()) {
        for (const member of group.members)
          liveHolds.add(memberHoldKey(member.threadId, member.watch));
      }
      for (const memory of [lastRead, cachedRead, readFailures, pausedUntilMs, readAfterMs]) {
        for (const key of memory.keys()) if (!groups.has(key)) memory.delete(key);
      }
      for (const key of heldSinceMs.keys()) if (!liveHolds.has(key)) heldSinceMs.delete(key);
      for (const [threadId, watches] of heldMembers) {
        for (const [watchId, key] of watches) {
          if (!groups.has(key)) unmarkHeld(threadId, watchId);
        }
      }
    };

    /** One pass over every watched pull request, or only over `only` (reads a decision asked for). */
    const sweepPass = (options: {
      readonly only: ReadonlySet<string> | null;
      readonly forceDetail: boolean;
    }) =>
      Effect.gen(function* () {
        const { groups, ends } = yield* collectGroups;
        if (options.only === null) {
          yield* Effect.forEach(ends, ({ member, reason }) => endMember(member, reason), {
            discard: true,
          });
          pruneMemory(groups);
        }
        const selected = [...groups.values()].filter(
          (group) => options.only === null || options.only.has(group.key),
        );
        yield* Effect.forEach(selected, (group) => passGroup(group, options), {
          concurrency: LIMITS.groupReadConcurrency,
          discard: true,
        });
      }).pipe(
        helpers.inBackgroundLane,
        Effect.catchCause((cause) =>
          logWatch(
            "sweep",
            "Pull request watch sweep failed; it runs again on schedule",
            {},
            cause,
          ),
        ),
      );

    /** Held wakes and pending deliveries, re-decided from the cached reads (no host reads). */
    const recheckHeld = Effect.gen(function* () {
      // A snapshot: each decision marks and unmarks held watches while this runs.
      const held = Array.from(heldMembers, ([threadId, watches]) => ({
        threadId,
        watches: Array.from(watches),
      }));
      for (const { threadId, watches } of held) {
        for (const [watchId, groupKey] of watches) {
          const read = cachedRead.get(groupKey);
          if (read === undefined) {
            unmarkHeld(threadId, watchId);
            continue;
          }
          yield* decideMember(threadId, watchId, groupKey, (watch) => observedRead(read, watch));
        }
      }
    });

    const isHeldWakeEvent = (event: OrchestrationEvent) =>
      event.aggregateKind === "thread" &&
      heldMembers.has(event.aggregateId as ThreadId) &&
      (HELD_WAKE_EVENT_TYPES.has(event.type) || helpers.isThreadWaitWakeEvent(event));

    const run: Effect.Effect<never> = Effect.scoped(
      Effect.gen(function* () {
        const woken = yield* Latch.make(false);
        // Thread events (#807's bus) free held wakes at once; the 10 s re-check is the safety net.
        const events = yield* engine.subscribeDomainEvents;
        yield* Stream.runForEach(events, (event) =>
          isHeldWakeEvent(event) ? Effect.asVoid(woken.open) : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            logWatch("events", "Pull request watch stopped following thread events", {}, cause),
          ),
          Effect.forkScoped,
        );
        let nextSweepAtMs = yield* Clock.currentTimeMillis;
        let lastRecheckMs = Number.NEGATIVE_INFINITY;
        while (true) {
          yield* woken.close;
          const nowMs = yield* Clock.currentTimeMillis;
          if (nowMs >= nextSweepAtMs) {
            nextSweepAtMs = nowMs + LIMITS.sweepIntervalMs;
            yield* sweepPass({ only: null, forceDetail: false });
          } else {
            const due = [...readAfterMs].filter(([, at]) => at <= nowMs).map(([key]) => key);
            for (const key of due) readAfterMs.delete(key);
            if (due.length > 0) yield* sweepPass({ only: new Set(due), forceDetail: true });
            yield* recheckHeld;
          }
          lastRecheckMs = yield* Clock.currentTimeMillis;
          const wakeAtMs = Math.min(
            nextSweepAtMs,
            heldMembers.size > 0
              ? lastRecheckMs + LIMITS.heldWakeRecheckMs
              : Number.POSITIVE_INFINITY,
            ...readAfterMs.values(),
          );
          yield* Effect.race(
            Effect.sleep(Duration.millis(Math.max(0, wakeAtMs - lastRecheckMs))),
            woken.await,
          );
          // A burst of thread events re-checks once per spacing.
          const wokenAtMs = yield* Clock.currentTimeMillis;
          if (wokenAtMs - lastRecheckMs < HELD_RECHECK_MIN_SPACING_MS) {
            yield* Effect.sleep(
              Duration.millis(HELD_RECHECK_MIN_SPACING_MS - (wokenAtMs - lastRecheckMs)),
            );
          }
        }
      }),
    );

    // ── Starting, changing and stopping a watch ──────────────────────

    const dispatchLinks = helpers.dispatchLinks;

    /** The workspace a thread works in: its own, the one at its checkout, or the project's main one. */
    const threadWorkspace = (shell: OrchestrationThreadShell) =>
      Effect.gen(function* () {
        if (shell.worktreeId != null) {
          const own = yield* worktrees.getById({ worktreeId: shell.worktreeId });
          if (Option.isSome(own)) return own.value;
        }
        if (shell.worktreePath !== null) {
          const atPath = yield* worktrees.findActiveByWorktreePath({
            worktreePath: shell.worktreePath,
          });
          return Option.getOrNull(atPath);
        }
        const all = yield* worktrees.listByProjectId({ projectId: shell.projectId });
        return (
          all.find((worktree) => worktree.origin === "main" && worktree.archivedAt === null) ?? null
        );
      });

    /** The pull request a request names (number, URL or both), checked for agreement. */
    const requestedPullRequest = (request: PullRequestWatchSetRequest) =>
      Effect.gen(function* () {
        if (request.url === undefined) {
          return { number: request.number, urlKey: null } satisfies RequestedPullRequest;
        }
        const urlKey = helpers.repositoryKey(request.url);
        const fromUrl = helpers.numberFromUrl(request.url);
        if (urlKey === null || fromUrl === null) {
          return yield* watchError("no-pull-request", "That URL does not name a pull request.");
        }
        if (request.number !== undefined && request.number !== fromUrl) {
          return yield* watchError(
            "no-pull-request",
            `The URL names #${fromUrl}, not #${request.number}. Name one pull request.`,
          );
        }
        return { number: fromUrl, urlKey } satisfies RequestedPullRequest;
      });

    const threadLink = (worktree: Worktree, shell: OrchestrationThreadShell) =>
      helpers.resolveThreadPullRequestLink(
        helpers.readWorktreePullRequestLinks(worktree),
        helpers.threadUserAnchorTimestamp({
          createdAt: shell.createdAt,
          latestUserMessageAt: shell.latestUserMessageAt,
          latestTurnRequestedAt: shell.latestTurn?.requestedAt ?? null,
        }),
      );

    /**
     * Which pull request, and which workspace links it. A named one may be linked to any
     * workspace of the thread's project (a delegated chat's, say); one no workspace links yet is
     * for the thread's own workspace, once its repository matches the checkout's, and
     * `pendingLink` writes it there once the watch goes through (a refused one links nothing).
     * Without a name: the pull request of the thread's workspace, discovered now if the agent
     * just opened it. `foreign`: another workspace than the thread's own links it.
     */
    const resolveTarget = (
      shell: OrchestrationThreadShell,
      request: PullRequestWatchSetRequest,
      named: RequestedPullRequest,
    ) =>
      Effect.gen(function* () {
        const own = yield* threadWorkspace(shell).pipe(
          Effect.mapError(() =>
            watchError("thread-unavailable", "Could not read the chat's workspace."),
          ),
        );
        const { number, urlKey } = named;
        if (number !== undefined) {
          const project = yield* worktrees
            .listByProjectId({ projectId: shell.projectId })
            .pipe(
              Effect.mapError(() =>
                watchError("thread-unavailable", "Could not read the project's workspaces."),
              ),
            );
          const candidates = [
            ...(own === null ? [] : [own]),
            ...project.filter((worktree) => worktree.worktreeId !== own?.worktreeId),
          ].filter(usableWorkspace);
          for (const worktree of candidates) {
            const link = visibleLink(worktree, number);
            if (
              link !== undefined &&
              (urlKey === null || link.url == null || helpers.repositoryKey(link.url) === urlKey)
            ) {
              return {
                worktree,
                link,
                foreign: worktree.worktreeId !== own?.worktreeId,
                pendingLink: null,
              };
            }
          }
          if (own === null || !usableWorkspace(own)) {
            return yield* watchError(
              "no-pull-request",
              `No workspace of this project links #${number}, and the chat has no workspace to link it to.`,
            );
          }
          // Bringing back a pull request the user removed from the workspace is the user's call.
          const dismissed = helpers
            .readWorktreePullRequestLinks(own)
            .some((link) => link.number === number && Boolean(link.dismissedAt));
          if (dismissed && request.origin === "agent") {
            return yield* watchError(
              "no-pull-request",
              `The user removed #${number} from this chat's workspace. Ask them to link it again to watch it.`,
            );
          }
          const cwd = yield* workspaceCwd(own).pipe(
            Effect.mapError(() => watchError("thread-unavailable", "Could not read the project.")),
          );
          if (cwd === null) {
            return yield* watchError("thread-unavailable", "The chat's workspace has no checkout.");
          }
          const pending: PullRequestLinkUpdate[] = [];
          const link = yield* helpers
            .linkPullRequest({
              worktree: own,
              cwd,
              reference: request.url ?? String(number),
              operation: "watchPullRequest",
              dispatch: (update) => Effect.sync(() => void pending.push(update)),
            })
            .pipe(
              Effect.mapError((error) =>
                watchError(
                  helpers.isWrongRepositoryLinkFailure(error) ? "wrong-repository" : "unreadable",
                  error.detail,
                ),
              ),
            );
          return { worktree: own, link, foreign: false, pendingLink: pending[0] ?? null };
        }
        if (own === null) {
          return yield* watchError(
            "no-pull-request",
            "This chat has no workspace with a pull request.",
          );
        }
        let worktree = own;
        let link = threadLink(worktree, shell);
        if (link === null && worktree.origin !== "main") {
          // The agent may have opened it moments ago: link the branch's pull request first.
          yield* helpers.refreshWorkspace({
            worktreeId: worktree.worktreeId,
            discoverPullRequest: helpers.discoverPullRequest,
            discoveryIntervalMs: 0,
          });
          const refreshed = yield* worktrees
            .getById({ worktreeId: worktree.worktreeId })
            .pipe(Effect.orElseSucceed(() => Option.none<Worktree>()));
          if (Option.isSome(refreshed)) worktree = refreshed.value;
          link = threadLink(worktree, shell);
        }
        if (link === null) {
          return yield* watchError(
            "no-pull-request",
            worktree.origin === "main"
              ? MAIN_CHECKOUT_DETAIL
              : "No pull request is linked to this chat's workspace yet.",
          );
        }
        return { worktree, link, foreign: false, pendingLink: null };
      });

    /** Another thread already runs Auto-fix CI on this pull request (one owner per pull request). */
    const autoFixOwnedElsewhere = (threadId: ThreadId, watchId: string) =>
      watchRows
        .listActive()
        .pipe(
          Effect.map((rows) =>
            rows.some(
              (row) =>
                row.threadId !== threadId &&
                row.watches.active.some(
                  (watch) => watch.watchId === watchId && watch.autoFix !== null,
                ),
            ),
          ),
        );

    const dispatchSet = (input: Parameters<typeof applyUpdate>[0]) =>
      applyUpdate(input).pipe(
        Effect.flatMap((outcome) =>
          outcome === "accepted"
            ? Effect.void
            : Effect.fail(
                watchError(
                  "thread-unavailable",
                  "The chat did not take the watch change. Check that it is active and try again.",
                ),
              ),
        ),
      );

    const setWatch = (request: PullRequestWatchSetRequest) =>
      serial.withLock(
        request.threadId,
        Effect.gen(function* () {
          if (request.origin === "agent" && request.autoFix !== undefined) {
            return yield* watchError(
              "unsupported",
              "An agent can start or stop watching a pull request; Auto-fix CI is the user's switch.",
            );
          }
          const readFailure = () =>
            watchError("thread-unavailable", "Could not read the chat. Try again.");
          const shell = yield* threadShell(request.threadId).pipe(Effect.mapError(readFailure));
          // Only a request that turns something on may start a watch (neither set means news).
          const turnsOn =
            request.news === true ||
            request.autoFix === true ||
            (request.news === undefined && request.autoFix === undefined);
          // Archiving or settling a chat ends its watches, so a request that only stops one
          // still runs below and answers that nothing is watched.
          if (
            shell === null ||
            (turnsOn && (shell.archivedAt !== null || shell.settledOverride === "settled"))
          ) {
            return yield* watchError(
              "thread-unavailable",
              "Only an active chat watches pull requests. Make it active first.",
            );
          }
          const named = yield* requestedPullRequest(request);
          const settings = {
            ...(request.news === undefined ? {} : { news: request.news }),
            ...(request.autoFix === undefined ? {} : { autoFix: request.autoFix }),
          };
          const nowMs = yield* Clock.currentTimeMillis;
          const nowIso = iso(nowMs);
          const row = yield* watchRows
            .getByThreadId({ threadId: request.threadId })
            .pipe(Effect.mapError(readFailure));
          const active = Option.isSome(row) ? row.value.watches.active : [];

          /**
           * A request that only turns something off, applied to the watch it names. It needs
           * neither the pull request's workspace nor a host read: a watch the thread has can
           * always be stopped or switched down, even once its link is gone or while its host
           * cannot be read (rate-limited, signed out, offline).
           */
          const turnOff = (watch: ThreadPullRequestWatch) =>
            Effect.gen(function* () {
              const change = changePullRequestWatch(watch, settings, nowIso);
              if (change.type === "unchanged") {
                return { watch: summarizePullRequestWatch(watch), now: watchingLine(watch) };
              }
              const next = change.type === "end" ? null : change.next;
              yield* dispatchSet({
                threadId: request.threadId,
                watch,
                next,
                ...(change.type === "end" ? { endReason: change.reason } : {}),
                createdAt: nowIso,
              });
              return next === null
                ? { watch: null, now: `Stopped watching #${watch.number}.` }
                : { watch: summarizePullRequestWatch(next), now: watchingLine(next) };
            });

          const matching = active.filter(
            (watch) =>
              (named.number === undefined || watch.number === named.number) &&
              (named.urlKey === null || helpers.repositoryKey(watch.url) === named.urlKey),
          );
          if (!turnsOn) {
            // The one watch the request names (or, naming none, the chat's only watch).
            let stopping = matching.length === 1 ? matching[0] : undefined;
            if (matching.length > 1 && named.number === undefined) {
              // Several watched and none named: the one of the chat's own workspace, else ask
              // (never the workspace's pull request found by a host read while others stay on).
              const own = yield* threadWorkspace(shell).pipe(Effect.mapError(readFailure));
              const owned = matching.filter((watch) => watch.worktreeId === own?.worktreeId);
              if (owned.length !== 1) {
                return yield* watchError(
                  "no-pull-request",
                  `This chat watches ${matching.map((watch) => `#${watch.number}`).join(", ")}. Name the one to stop.`,
                );
              }
              stopping = owned[0];
            }
            if (stopping !== undefined) return yield* turnOff(stopping);
            if (matching.length === 0) {
              return {
                watch: null,
                now:
                  named.number === undefined
                    ? "Not watching a pull request."
                    : `Not watching #${named.number}.`,
              };
            }
          }

          const { worktree, link, foreign, pendingLink } = yield* resolveTarget(
            shell,
            request,
            named,
          );
          // A fix turn edits the woken chat's own checkout: on a pull request another workspace
          // checks out (a delegated chat's worktree) it could not even switch to the branch.
          if (request.autoFix === true && foreign) {
            return yield* watchError(
              "unsupported",
              `Auto-fix CI works in the chat's own checkout. Turn it on in the chat whose workspace has #${link.number}.`,
            );
          }
          const linkWatchId = link.url == null ? null : watchIdOf(link.url, link.number);
          const findExisting = (watchId: string | null) =>
            active.find(
              (watch) =>
                (watchId !== null && watch.watchId === watchId) ||
                (watch.number === link.number && watch.worktreeId === worktree.worktreeId),
            );
          let existing = findExisting(linkWatchId);
          if (!turnsOn) {
            return existing === undefined
              ? { watch: null, now: `Not watching #${link.number}.` }
              : yield* turnOff(existing);
          }
          /** A pull request no workspace linked is linked once the change goes through. */
          const linkFirst = <A>(effect: Effect.Effect<A, PullRequestWatchError>) =>
            pendingLink === null
              ? effect
              : dispatchLinks(pendingLink).pipe(
                  Effect.mapError((error) => watchError("thread-unavailable", error.detail)),
                  Effect.andThen(effect),
                );

          const cwd = yield* workspaceCwd(worktree).pipe(Effect.mapError(readFailure));
          if (cwd === null) {
            return yield* watchError("unreadable", "No checkout can read this pull request.");
          }
          const unreadable = (error: { readonly detail?: string }) =>
            watchError(
              "unreadable",
              error.detail ?? `Could not read #${link.number} from its host.`,
            );
          const provider = yield* registry.resolve({ cwd }).pipe(Effect.mapError(unreadable));
          const detail = yield* provider
            .getChangeRequestDetail({ cwd, reference: String(link.number), fullContent: false })
            .pipe(Effect.mapError(unreadable));
          // A link without a URL matched by number alone: the named URL must be this one's.
          if (named.urlKey !== null && helpers.repositoryKey(detail.url) !== named.urlKey) {
            return yield* watchError(
              "wrong-repository",
              `That URL names another repository's pull request, not #${detail.number} of this project's checkout.`,
            );
          }
          const watchId = watchIdOf(detail.url, detail.number);
          if (watchId === null) {
            return yield* watchError(
              "unsupported",
              `Ryco cannot tell which repository #${detail.number} belongs to.`,
            );
          }
          existing ??= findExisting(watchId);
          const turningAutoFixOn =
            request.autoFix === true && (existing === undefined || existing.autoFix === null);
          /**
           * One Auto-fix CI owner per pull request: the check and the change that turns it on
           * run under one lock per pull request, so two chats turning it on at once cannot both
           * pass the check (each chat's own lock does not cover the other chat).
           */
          const claimAutoFix = <A>(effect: Effect.Effect<A, PullRequestWatchError>) =>
            !turningAutoFixOn
              ? effect
              : autoFixOwners.withLock(
                  watchId,
                  Effect.gen(function* () {
                    const owned = yield* autoFixOwnedElsewhere(request.threadId, watchId).pipe(
                      Effect.mapError(readFailure),
                    );
                    if (owned) {
                      return yield* watchError(
                        "auto-fix-owned",
                        `Another chat already runs Auto-fix CI on #${detail.number}.`,
                      );
                    }
                    return yield* effect;
                  }),
                );

          if (existing !== undefined) {
            const now = describePullRequestWatchNow(
              pullRequestWatchObservation({
                detail,
                activity: null,
                remarksThrough: existing.remarksThrough,
                observedAtMs: nowMs,
              }),
            );
            const change = changePullRequestWatch(existing, settings, nowIso);
            switch (change.type) {
              case "unchanged":
                yield* linkFirst(Effect.void);
                return { watch: summarizePullRequestWatch(existing), now };
              case "update":
                yield* claimAutoFix(
                  linkFirst(
                    dispatchSet({
                      threadId: request.threadId,
                      watch: existing,
                      next: change.next,
                      createdAt: nowIso,
                    }),
                  ),
                );
                return { watch: summarizePullRequestWatch(change.next), now };
              case "end":
                yield* dispatchSet({
                  threadId: request.threadId,
                  watch: existing,
                  next: null,
                  endReason: change.reason,
                  createdAt: nowIso,
                });
                // As every other stop answers: the caller asked to stop, not for the checks.
                return { watch: null, now: `Stopped watching #${existing.number}.` };
            }
          }

          if (detail.state !== "open") {
            return yield* watchError(
              "not-open",
              `#${detail.number} is ${detail.state}, so there is nothing to watch.`,
            );
          }
          if (active.length >= LIMITS.maxWatchesPerThread) {
            return yield* watchError(
              "limit",
              `A chat watches at most ${LIMITS.maxWatchesPerThread} pull requests. Stop watching one first.`,
            );
          }
          // The conversation as it is now seeds the remark watermark on the host's clock.
          const activity = yield* readActivity(provider, cwd, detail.number).pipe(
            Effect.orElseSucceed(() => null),
          );
          const observation = pullRequestWatchObservation({
            detail,
            activity,
            remarksThrough: nowIso,
            observedAtMs: nowMs,
          });
          const news = request.news ?? request.autoFix !== true;
          const next = startPullRequestWatch({
            watchId,
            number: detail.number,
            url: detail.url,
            provider: provider.kind,
            worktreeId: worktree.worktreeId,
            startedBy: request.origin,
            runtimeMode: shell.runtimeMode,
            worktreePath: shell.worktreePath,
            news,
            autoFix: request.autoFix === true,
            observation,
            nowIso,
          });
          yield* claimAutoFix(
            linkFirst(
              commands
                .applyInternal({
                  type: "thread.pull-request-watch.update",
                  commandId: helpers.updateCommandId({
                    threadId: request.threadId,
                    watchId,
                    revision: 0,
                  }),
                  threadId: request.threadId,
                  watchId,
                  expectedRevision: null,
                  expectedStartedAt: null,
                  next,
                  createdAt: nowIso,
                })
                .pipe(
                  Effect.mapError((error) =>
                    watchError(
                      "thread-unavailable",
                      refusalDetail(error) ?? "The chat did not take the watch. Try again.",
                    ),
                  ),
                ),
            ),
          );
          return {
            watch: summarizePullRequestWatch(next),
            now: describePullRequestWatchNow(observation),
          };
        }),
      );

    return {
      setWatch,
      sweep: sweepPass({ only: null, forceDetail: false }),
      recheck: recheckHeld,
      run,
    } satisfies PullRequestWatchRuntime;
  });
