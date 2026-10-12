/**
 * ThreadForkLive - accepts, runs and recovers chat forks.
 *
 * Acceptance reads the source from SQL, resolves the boundary, validates the destination, pins
 * the commits a new worktree needs, decides the provider strategy (pinning where a Claude copy
 * ends against the source transcript) and builds the publication; it writes the `thread_forks`
 * row last, so a refused request leaves nothing behind. The run then advances the row phase by
 * phase with compare-and-set, recording what it is about to create before creating it:
 *
 *   accepted → [checkout-preparing] → checkout-ready → [provider-forking] → provider-ready
 *            → published → completed            (or failed, after cleaning up what it owns)
 *
 * A retried key joins the running attempt in this process or resumes from the recorded phase.
 * The node also drives unfinished rows itself: startup resumes every one once commands are
 * admitted, a run that stops with its row unfinished is driven again after a growing wait, and a
 * periodic sweep picks up any unfinished row nothing drives and expires abandoned retries. A fork
 * whose runs keep stopping is settled instead (cleaned up, then recorded as failed), so it stops
 * reporting `running` unless that cleanup itself keeps failing; a destination that is gone fails
 * the fork before anything is reserved for it. A native fork call is made at most once per key: a
 * run that finds `provider-forking` recorded hands off instead. Cleanup only ever removes
 * resources the row records as created by this fork. A failure is recorded as `failed` only once
 * that cleanup succeeded; until then the row stays unfinished and the next attempt finishes it.
 * Every error a caller sees carries what the ledger then holds for its key
 * (`ThreadForkError.attempt`).
 *
 * @module ThreadForkLive
 */
import {
  type OrchestrationProjectShell,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ServerSettings,
  type ThreadForkAttemptState,
  type ThreadForkCheckout,
  type ThreadForkCreateCommand,
  ThreadForkError,
  type ThreadForkErrorReason,
  type ThreadForkInput,
  type ThreadForkResult,
  type ThreadId,
  type TurnId,
  VcsUnsupportedOperationError,
  type WorktreeId,
} from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";
import { truncateUnicodeSafe } from "@ryco/shared/String";
import { worktreeSubmoduleSetupNotice } from "@ryco/shared/worktreeSubmodules";
import {
  Cause,
  Data,
  Deferred,
  type Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";

import {
  deleteThreadAttachmentFiles,
  materializeInheritedAttachment,
} from "../../attachmentStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { CHECKPOINT_REFS_PREFIX, forkPinRefs } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { isCheckpointRevertPending } from "../../orchestration/checkpointRevertPolicy.ts";
import {
  OrchestrationCommandAdmissionError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ThreadForkRepository } from "../../persistence/Services/ThreadForks.ts";
import { ChatFolders } from "../../project/chatFolders.ts";
import { resolveProjectPreferences } from "../../project/projectPreferences.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { WorkspaceAccessPolicy } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import {
  type ChatBootstrapDependencies,
  prepareChatProject,
  releasePreparedChatFolder,
} from "../../ws/context/chatBootstrap.ts";
import {
  createManagedCheckout,
  isManagedCheckoutPathRefusal,
  launchSetupScriptForWorktreeInBackground,
  makeAppendSetupScriptActivity,
  type ManagedCheckoutDeps,
  removeOwnedCheckout,
  resolveManagedCheckoutPath,
} from "../../ws/context/managedCheckout.ts";
import {
  type ForkBoundary,
  type ForkBoundarySession,
  type ForkBoundaryTurn,
  resolveForkBoundary,
} from "../forkBoundary.ts";
import {
  type ThreadForkCheckoutPlan,
  type ThreadForkCheckoutRecord,
  type ThreadForkFailure,
  threadForkAttemptState,
  threadForkIdentity,
  type ThreadForkLedgerPatch,
  type ThreadForkLedgerRow,
  type ThreadForkOwnedNativeCopy,
  type ThreadForkPhase,
  type ThreadForkPlan,
  type ThreadForkProviderPlan,
  type ThreadForkProviderRecord,
  threadForkRequestDigest,
} from "../forkLedger.ts";
import {
  buildForkPublication,
  finalizeForkPublication,
  FORK_SKIPPED_ATTACHMENTS_NOTICE,
  type ForkPublicationOutcome,
  forkThreadTitle,
  withoutUnlinkedAttachments,
} from "../forkPlan.ts";
import {
  type ClaudeNativeCandidate,
  pinClaudeForkPlan,
  planForkProvider,
} from "../forkProvider.ts";
import {
  type ClaudeCutoffPin,
  claudeForkResumeCursor,
  claudeForkSessionTitle,
  codexForkResumeCursor,
  forkClaudeThroughTurn,
  forkCodexThroughTurn,
  NativeForkCleanupError,
  type NativeForkOutcome,
  NativeForkUncertain,
  nativeForkConfigFingerprint,
  pinClaudeForkCutoff,
  removeClaudeForkCopy,
  removeCodexForkCopy,
  resolveNativeForkStore,
} from "../nativeFork.ts";
import { ThreadFork, type ThreadForkShape } from "../Services/ThreadFork.ts";

type NativeProviderPlan = Extract<ThreadForkProviderPlan, { readonly kind: "native" }>;
type WorktreeCheckoutPlan = Extract<ThreadForkCheckoutPlan, { readonly kind: "new-worktree" }>;
type WorktreeCheckoutRecord = Extract<ThreadForkCheckoutRecord, { readonly kind: "new-worktree" }>;
type HandoffProviderRecord = Extract<ThreadForkProviderRecord, { readonly kind: "handoff" }>;

/** A request for the provider-native copy of the source's session, ending at the boundary. */
export interface ThreadForkNativeForkRequest {
  readonly forkThreadId: ThreadId;
  readonly plan: NativeProviderPlan;
  readonly config: ProviderInstanceConfig;
  /** The fork's effective cwd, canonical. */
  readonly targetCwd: string;
}

/** Provider-native fork operations; tests replace them with fakes. */
export interface ThreadForkNativeOperations {
  /**
   * Reads the source's Claude transcript once, while the fork is accepted, and pins where the
   * copy will end. Read-only.
   */
  readonly pinClaudeCutoff: (request: {
    readonly plan: ClaudeNativeCandidate["plan"];
    readonly config: ProviderInstanceConfig;
    readonly laterTurnIds: ReadonlyArray<TurnId>;
  }) => Effect.Effect<ClaudeCutoffPin>;
  /** At most once per fork key. Never repeated when its outcome is uncertain. */
  readonly fork: (
    request: ThreadForkNativeForkRequest,
  ) => Effect.Effect<NativeForkOutcome, NativeForkUncertain>;
  /** Deletes a copy this fork created and recorded (never one it merely may have created). */
  readonly removeCopy: (input: {
    readonly plan: NativeProviderPlan;
    readonly config: ProviderInstanceConfig | undefined;
    readonly nativeThreadId: string;
    readonly copy: ThreadForkOwnedNativeCopy;
  }) => Effect.Effect<void, NativeForkCleanupError>;
}

/** Named points of a run; a test hook failing or dying there simulates a crash. */
export type ThreadForkRunPoint =
  | "accepted"
  | "checkout-preparing"
  | "checkout-created"
  | "provider-forking"
  | "provider-ready"
  /** The publication committed; its `published` phase is not recorded yet. */
  | "publish-committed"
  | "published";

export interface ThreadForkTestOptions {
  readonly native?: Partial<ThreadForkNativeOperations>;
  readonly onRunPoint?: (
    point: ThreadForkRunPoint,
    row: ThreadForkLedgerRow,
  ) => Effect.Effect<void>;
  /** Forks running at once in this process (default 2). */
  readonly maxConcurrentForks?: number;
  /** Clock for expiring abandoned retries (default: the system clock). */
  readonly now?: () => Date;
  /**
   * Waits before the node drives a fork again after a run stopped and left it unfinished; the
   * last one repeats (default `THREAD_FORK_REDRIVE_BACKOFF`).
   */
  readonly redriveBackoff?: ReadonlyArray<Duration.Input>;
  /** Interval of the recovery sweep once commands are admitted (default 15 minutes). */
  readonly recoverySweepInterval?: Duration.Input;
  /**
   * Runs in a row that may stop with a fork unfinished before the node settles it (default
   * `THREAD_FORK_REDRIVE_LIMIT`).
   */
  readonly redriveLimit?: number;
}

const DEFAULT_MAX_CONCURRENT_FORKS = 2;
/**
 * How long a fork that stopped with a retryable failure keeps its pinned commits for a retry.
 * After that, the next retry or recovery sweep releases them and the fork can no longer be
 * retried.
 */
export const THREAD_FORK_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long the node waits before it drives an unfinished fork again after a run stopped (a
 * publication refused for a moment, an interrupted write, a cleanup that failed): growing waits,
 * then every 10 minutes until the fork finishes or the node settles it.
 */
export const THREAD_FORK_REDRIVE_BACKOFF: ReadonlyArray<Duration.Input> = [
  "5 seconds",
  "30 seconds",
  "2 minutes",
  "10 minutes",
];
/**
 * Once this many runs in a row stopped with a fork unfinished on this node (about an hour with
 * `THREAD_FORK_REDRIVE_BACKOFF`), the node's next run settles the fork instead of driving it: it
 * removes what the fork created and records a failure, so the key stops reporting `running`.
 */
export const THREAD_FORK_REDRIVE_LIMIT = 10;
/**
 * A fork that has not advanced for this long is settled sooner: once a few runs on this node
 * stopped too. A node that restarts before it reaches `THREAD_FORK_REDRIVE_LIMIT` still settles it.
 */
export const THREAD_FORK_STALLED_AFTER_MS = 24 * 60 * 60 * 1000;
/** Runs on this node that must have stopped before a stalled fork is settled. */
const THREAD_FORK_STALLED_MIN_STOPS = 3;
/**
 * How often the node sweeps the ledger once commands are admitted: it expires abandoned retries
 * and drives every unfinished fork that no attempt is running or scheduled for.
 */
export const THREAD_FORK_RECOVERY_SWEEP_INTERVAL: Duration.Input = "15 minutes";
const UNCERTAIN_NATIVE_FORK_NOTICE =
  "The provider may have made a copy of the conversation that Ryco could not confirm. Ryco did not repeat the copy and does not use it.";
const NOTICE_MAX_CHARS = 500;

/**
 * A failure inside acceptance or a run. The service reports it to callers as a
 * `ThreadForkError` whose `attempt` is what the ledger holds for the key by then.
 */
class ForkRunError extends Data.TaggedError("ForkRunError")<ThreadForkFailure> {}

const isForkRunError = (value: unknown): value is ForkRunError => value instanceof ForkRunError;

const forkError = (reason: ThreadForkErrorReason, message: string, retryable = false) =>
  new ForkRunError({ reason, message, retryable });

const failureOf = (error: ForkRunError): ThreadForkFailure => ({
  reason: error.reason,
  message: error.message,
  retryable: error.retryable,
});

const errorOf = (failure: ThreadForkFailure) =>
  forkError(failure.reason, failure.message, failure.retryable);

const CONFLICT_MESSAGE =
  "This fork key was already used for a different request. Fork again with a new key.";

const conflictError = () => forkError("idempotency-conflict", CONFLICT_MESSAGE);

/** A run stopped by something transient; its recorded phase resumes on retry. */
const interruptedRunError = (detail?: string) =>
  forkError(
    "preparation-failed",
    detail ?? "The fork could not finish. Retry to resume it where it stopped.",
    true,
  );

const describeCause = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;

/** No turn is running or about to run in the session. */
const isSessionIdle = (session: ForkBoundarySession | null) =>
  session === null ||
  (session.activeTurnId === null && session.status !== "running" && session.status !== "starting");

/** Identifies a thread's turn rows and their states; any change between two reads differs. */
const turnRowsFingerprint = (turns: ReadonlyArray<ForkBoundaryTurn>) =>
  turns
    .map((turn) => `${turn.turnId ?? ""}\u0000${turn.pendingMessageId ?? ""}\u0000${turn.state}`)
    .toSorted()
    .join("\n");

/** What the fork's provenance and result say about where it lives. */
function forkCheckout(
  plan: ThreadForkCheckoutPlan,
  record: ThreadForkCheckoutRecord,
): ThreadForkCheckout {
  switch (record.kind) {
    case "current-checkout":
      return { kind: "current-checkout", worktreePath: record.worktreePath, branch: record.branch };
    case "new-worktree":
      return {
        kind: "new-worktree",
        worktreeId: record.worktreeId,
        worktreePath: record.worktreePath,
        branch: record.branch,
        start: plan.kind === "new-worktree" ? plan.start : "base-ref",
        baseRef: plan.kind === "new-worktree" ? plan.baseRef : record.branch,
      };
    case "new-chat":
      return { kind: "new-chat", folder: record.folder };
  }
}

/**
 * The outcome a publication is drafted with at acceptance. Paths that only exist once the run
 * created them (a new worktree, a new chat's folder) are placeholders until
 * `finalizeForkPublication` applies the run's actual checkout; nothing is published from a draft.
 */
function plannedOutcome(
  checkout: ThreadForkCheckoutPlan,
  provider: ThreadForkProviderPlan,
): ForkPublicationOutcome {
  const planned: ThreadForkCheckout =
    checkout.kind === "current-checkout"
      ? { kind: "current-checkout", worktreePath: checkout.worktreePath, branch: checkout.branch }
      : checkout.kind === "new-worktree"
        ? {
            kind: "new-worktree",
            worktreeId: checkout.worktreeId,
            worktreePath: checkout.repositoryRoot,
            branch: checkout.branch,
            start: checkout.start,
            baseRef: checkout.baseRef,
          }
        : { kind: "new-chat", folder: checkout.titleSeed };
  return {
    checkout: planned,
    sourceWorktreeId: checkout.kind === "current-checkout" ? checkout.worktreeId : null,
    providerContext: provider.kind === "native" ? "native" : "handoff",
    ...(provider.kind === "handoff" ? { handoffReason: provider.reason } : {}),
    notices: [],
  };
}

/**
 * The publication and result of a run whose checkout, provider and attachments are recorded.
 * Inherited attachments whose copy was never linked are dropped, so the fork never references a
 * file that does not exist.
 */
function finalPublication(row: ThreadForkLedgerRow): {
  readonly command: ThreadForkCreateCommand;
  readonly result: ThreadForkResult;
} {
  const { plan } = row;
  if (
    row.checkout === null ||
    row.provider === null ||
    row.provider.kind === "forking" ||
    (row.attachments === null && plan.attachments.length > 0)
  ) {
    throw new Error(`Fork '${row.forkKey}' has no recorded checkout, provider or attachments.`);
  }
  const checkout = forkCheckout(plan.checkout, row.checkout);
  const provider = row.provider;
  const linked = new Set(row.attachments?.attachmentIds ?? []);
  const unlinked = new Set(
    plan.attachments.map((copy) => copy.attachmentId).filter((id) => !linked.has(id)),
  );
  const notices = [
    ...(provider.kind === "handoff" && provider.reason === "native-fork-uncertain"
      ? [UNCERTAIN_NATIVE_FORK_NOTICE]
      : []),
    ...(unlinked.size > 0 ? [FORK_SKIPPED_ATTACHMENTS_NOTICE] : []),
    ...(row.checkout.kind === "new-worktree" && row.checkout.submoduleNotice !== undefined
      ? [row.checkout.submoduleNotice]
      : []),
  ];
  const command = finalizeForkPublication(
    withoutUnlinkedAttachments(plan.command, unlinked),
    {
      checkout,
      sourceWorktreeId: plan.checkout.kind === "current-checkout" ? plan.checkout.worktreeId : null,
      providerContext: provider.kind === "native" ? "native" : "handoff",
      ...(provider.kind === "handoff" ? { handoffReason: provider.reason } : {}),
      notices,
    },
    plan.notices,
  );
  return {
    command,
    result: {
      threadId: command.threadId,
      projectId: command.projectId,
      replayed: false,
      providerContext: command.forked.providerContext,
      checkout: command.forked.checkout,
      notices: command.forked.notices,
    },
  };
}

interface Flight {
  /** Null for a run the node drives itself (recovery, re-drive): it resumes a row without a request. */
  readonly digest: string | null;
  readonly outcome: Deferred.Deferred<ThreadForkResult, ThreadForkError>;
}

/** A key whose last run stopped with its row unfinished: how often, and the pending re-drive. */
interface Redrive {
  stops: number;
  scheduled: boolean;
}

export const makeThreadFork = (options: ThreadForkTestOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ledger = yield* ThreadForkRepository;
    const snapshots = yield* ProjectionSnapshotQuery;
    const turnRows = yield* ProjectionTurnRepository;
    const directory = yield* ProviderSessionDirectory;
    const serverSettings = yield* ServerSettingsService;
    const engine = yield* OrchestrationEngineService;
    const checkpoints = yield* CheckpointStore;
    const gitWorkflow = yield* GitWorkflowService;
    const workspaceAccessPolicy = yield* WorkspaceAccessPolicy;
    const config = yield* ServerConfig;
    const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
    const vcsStatus = yield* VcsStatusBroadcaster;
    const chatFolders = Option.getOrUndefined(yield* Effect.serviceOption(ChatFolders));
    const projectRecords = Option.getOrUndefined(
      yield* Effect.serviceOption(ProjectionProjectRepository),
    );
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const platform = yield* Effect.context<
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
    >();
    const serviceScope = yield* Effect.scope;
    const permits = yield* Semaphore.make(
      options.maxConcurrentForks ?? DEFAULT_MAX_CONCURRENT_FORKS,
    );
    const flights = new Map<string, Flight>();
    const redrives = new Map<string, Redrive>();
    /**
     * The new worktree path an `accepted` row reserved but has not recorded yet (a run stopped in
     * between): its next run here reuses it instead of reserving another one.
     */
    const reservedWorktreePaths = new Map<string, string>();
    const redriveBackoff =
      options.redriveBackoff !== undefined && options.redriveBackoff.length > 0
        ? options.redriveBackoff
        : THREAD_FORK_REDRIVE_BACKOFF;
    const redriveLimit = Math.max(1, options.redriveLimit ?? THREAD_FORK_REDRIVE_LIMIT);
    const now = options.now ?? (() => new Date());

    const managedCheckoutDeps: ManagedCheckoutDeps = {
      gitWorkflow,
      workspaceAccessPolicy,
      config,
    };
    const appendSetupScriptActivity = makeAppendSetupScriptActivity(engine.dispatch);
    const chatDeps = (forkKey: string): ChatBootstrapDependencies => ({
      chatFolders,
      projects: snapshots,
      projectRecords,
      dispatch: engine.dispatch,
      // Deterministic per fork: a resumed run's chat creation is answered by its receipt.
      serverCommandId: (tag) => threadForkIdentity(forkKey).commandId(tag),
    });

    const nativeOps: ThreadForkNativeOperations = {
      pinClaudeCutoff:
        options.native?.pinClaudeCutoff ??
        ((request) =>
          Effect.gen(function* () {
            const store = yield* Effect.result(
              resolveNativeForkStore(request.plan.driver, request.config),
            );
            if (store._tag === "Failure") {
              return { kind: "refused", detail: store.failure.detail } as const;
            }
            return yield* pinClaudeForkCutoff({
              root: store.success.root,
              environment: store.success.environment,
              sourceSessionId: request.plan.sourceNativeId,
              recordedCwd: request.plan.recordedCwd,
              turnId: request.plan.turnId,
              laterTurnIds: request.laterTurnIds,
            });
          }).pipe(Effect.provideContext(platform))),
      fork:
        options.native?.fork ??
        ((request) =>
          Effect.gen(function* () {
            const store = yield* Effect.result(
              resolveNativeForkStore(request.plan.driver, request.config),
            );
            if (store._tag === "Failure") {
              return { kind: "refused", detail: store.failure.detail } as const;
            }
            const { root, environment, binaryPath, codex } = store.success;
            const plan = request.plan;
            if (plan.driver === "codex") {
              if (codex === undefined) {
                return { kind: "refused", detail: "Codex has no session store." } as const;
              }
              return yield* forkCodexThroughTurn({
                layout: codex,
                environment,
                binaryPath,
                sourceNativeThreadId: plan.sourceNativeId,
                turnId: plan.turnId,
                cwd: request.targetCwd,
              });
            }
            return yield* forkClaudeThroughTurn({
              root,
              environment,
              sourceSessionId: plan.sourceNativeId,
              recordedCwd: plan.recordedCwd,
              targetCwd: request.targetCwd,
              turnId: plan.turnId,
              cutoff: plan.cutoff,
              title: claudeForkSessionTitle(request.forkThreadId),
            });
          }).pipe(Effect.provideContext(platform))),
      removeCopy:
        options.native?.removeCopy ??
        (({ copy, config: instanceConfig, nativeThreadId, plan }) => {
          if (copy.kind === "claude-file") {
            return removeClaudeForkCopy({
              root: copy.root,
              sessionId: nativeThreadId,
              file: copy.file,
            });
          }
          const threadId = copy.threadId;
          return Effect.gen(function* () {
            if (instanceConfig === undefined) {
              return yield* new NativeForkCleanupError({
                detail: "The provider instance is gone, so its Codex copy cannot be removed.",
              });
            }
            const store = yield* resolveNativeForkStore(plan.driver, instanceConfig).pipe(
              Effect.mapError(
                (cause) =>
                  new NativeForkCleanupError({ detail: "The Codex store is unavailable.", cause }),
              ),
            );
            if (store.codex === undefined) {
              return yield* new NativeForkCleanupError({ detail: "Codex has no session store." });
            }
            // The store root always exists; the fork's own folder may be gone by now.
            yield* removeCodexForkCopy({
              layout: store.codex,
              environment: store.environment,
              binaryPath: store.binaryPath,
              cwd: store.root,
              threadId,
            });
          }).pipe(Effect.provideContext(platform));
        }),
    };

    const runPoint = (point: ThreadForkRunPoint, row: ThreadForkLedgerRow) =>
      options.onRunPoint ? options.onRunPoint(point, row) : Effect.void;

    const nowIso = () => now().toISOString();

    /** A filesystem error that may pass: the run stops retryably and keeps what it recorded. */
    const unreadableFolder = (error: PlatformError.PlatformError) =>
      interruptedRunError(
        `Ryco could not check a folder this fork needs (${error.message}). Try again in a moment.`,
      );

    /**
     * Whether a path exists. Only a provably missing path answers no (it is not there, or a part
     * of it is not a folder): any other filesystem error (I/O, permissions, a stalled mount)
     * stops the run retryably instead, so a transient error never fails a fork for good or skips
     * the cleanup of what it created.
     */
    const pathExists = (candidate: string) =>
      fileSystem
        .exists(candidate)
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "BadResource"
              ? Effect.succeed(false)
              : Effect.fail(unreadableFolder(error)),
          ),
        );

    const readRow = (forkKey: string) =>
      ledger.getByKey({ forkKey }).pipe(Effect.map(Option.getOrUndefined));

    /**
     * What the ledger holds for a key; "running" when it cannot be read (never invites a second
     * fork). Reads the row without its plan.
     */
    const recordedAttempt = (forkKey: string) =>
      ledger.getStateByKey({ forkKey }).pipe(
        Effect.map((state) => threadForkAttemptState(Option.getOrUndefined(state))),
        Effect.orElseSucceed((): ThreadForkAttemptState => "running"),
      );

    /** The error a caller sees: the run's failure and what the node now holds for the key. */
    const reportError = (forkKey: string, error: ForkRunError) =>
      recordedAttempt(forkKey).pipe(
        Effect.map(
          (attempt) =>
            new ThreadForkError({
              reason: error.reason,
              message: error.message,
              retryable: error.retryable,
              attempt,
            }),
        ),
      );

    /**
     * Moves the row to `nextPhase`; fails when another owner moved it first. A row that settles
     * for good (`releaseHistory`) drops its inherited history from the stored plan; the run keeps
     * the plan it holds, which never changes otherwise. `fenceOnVersion` also requires the row to
     * be unchanged since it was read (its `updatedAt`): a transition out of `failed` is not fenced
     * by its phase alone, because settling a failure again keeps the phase.
     */
    const advance = (
      row: ThreadForkLedgerRow,
      nextPhase: ThreadForkPhase,
      patch: ThreadForkLedgerPatch,
      releaseHistory = false,
      fenceOnVersion = false,
    ) =>
      Effect.gen(function* () {
        const next = yield* ledger.compareAndSetPhase({
          forkKey: row.forkKey,
          expectedPhase: row.phase,
          ...(fenceOnVersion ? { expectedUpdatedAt: row.updatedAt } : {}),
          nextPhase,
          patch,
          releaseHistory,
          updatedAt: nowIso(),
        });
        if (Option.isNone(next)) {
          return yield* interruptedRunError(
            "Another attempt is advancing this fork. Retry in a moment.",
          );
        }
        return { ...next.value, plan: row.plan } satisfies ThreadForkLedgerRow;
      });

    const loadSettings = serverSettings.getSettings.pipe(
      Effect.mapError(() => interruptedRunError("Server settings are unavailable right now.")),
    );

    const requireProject = (projectId: ThreadForkPlan["projectId"]) =>
      snapshots.getProjectShellById(projectId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                forkError("destination-unavailable", "The fork's project no longer exists."),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

    const refreshGitStatus = (cwd: string) =>
      vcsStatus
        .refreshStatus(cwd)
        .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(serviceScope), Effect.asVoid);

    /** Drops the refs a new-worktree fork pinned its commits under. Best effort. */
    const deletePinRefs = (checkout: ThreadForkCheckoutPlan, forkThreadId: ThreadId) =>
      checkout.kind !== "new-worktree"
        ? Effect.void
        : checkpoints
            .deleteCheckpointRefs({
              cwd: checkout.repositoryRoot,
              checkpointRefs: Object.values(forkPinRefs(forkThreadId)),
            })
            .pipe(Effect.ignoreCause({ log: true }));

    /**
     * Why the source's checkout cannot be used anymore, or null: its worktree was removed (the
     * thread keeps the path) or its folder is gone.
     */
    const sourceCheckoutProblem = (
      source: { readonly worktreeId: WorktreeId | null; readonly worktreePath: string | null },
      projectRoot: string,
    ) =>
      Effect.gen(function* () {
        if (source.worktreeId !== null && snapshots.getWorktreeShellById !== undefined) {
          const worktree = yield* snapshots.getWorktreeShellById(source.worktreeId);
          if (Option.isNone(worktree) || worktree.value.checkoutRemovedAt != null) {
            return "The original thread's checkout was removed.";
          }
        }
        if (!(yield* pathExists(source.worktreePath ?? projectRoot))) {
          return "The original thread's folder no longer exists.";
        }
        return null;
      });

    // -------------------------------------------------------------------------------------------
    // Acceptance: validates and pins everything, writes the ledger row last.

    const planCheckout = (input: {
      readonly request: ThreadForkInput;
      readonly identity: ReturnType<typeof threadForkIdentity>;
      readonly settings: ServerSettings;
      readonly project: OrchestrationProjectShell;
      readonly source: {
        readonly id: ThreadId;
        readonly title: string;
        readonly worktreeId: WorktreeId | null;
        readonly worktreePath: string | null;
        readonly branch: string | null;
      };
      readonly boundary: ForkBoundary;
    }) =>
      Effect.gen(function* () {
        const { request, identity, project, source } = input;
        const destination = request.destination;
        const chat = isChatProject(project);
        switch (destination.kind) {
          case "current-checkout": {
            if (chat) {
              return yield* forkError(
                "destination-unavailable",
                "A chat without a project forks into a new chat.",
              );
            }
            const problem = yield* sourceCheckoutProblem(source, project.workspaceRoot);
            if (problem !== null) return yield* forkError("destination-unavailable", problem);
            return {
              kind: "current-checkout",
              worktreeId: source.worktreeId,
              worktreePath: source.worktreePath,
              branch: source.branch,
            } satisfies ThreadForkCheckoutPlan;
          }
          case "new-chat": {
            if (!chat) {
              return yield* forkError(
                "destination-unavailable",
                "Only a chat without a project forks into a new chat.",
              );
            }
            const available =
              chatFolders === undefined ? false : (yield* chatFolders.capability).available;
            if (!available) {
              return yield* forkError(
                "destination-unavailable",
                "Chats without a project are not available on this server.",
              );
            }
            return {
              kind: "new-chat",
              projectId: identity.chatProjectId,
              titleSeed: forkThreadTitle(source.title),
            } satisfies ThreadForkCheckoutPlan;
          }
          case "new-worktree": {
            const root = project.workspaceRoot;
            const start = destination.start;
            // Only a deterministic answer refuses the checkpoint start: the source checkout is no
            // longer a Git repository. Git that could not run (spawn, timeout), a projection read
            // or a filesystem error is retryable and never takes the user's start away; it is not
            // reported as a busy source either.
            const gitUnreadable = (error: unknown) =>
              isForkRunError(error)
                ? error
                : start.kind === "checkpoint" && Schema.is(VcsUnsupportedOperationError)(error)
                  ? forkError(
                      "checkpoint-unavailable",
                      `Git could not read this turn's checkpoint (${describeCause(error, "unknown error")}). Start from a branch or commit instead.`,
                    )
                  : forkError(
                      "destination-unavailable",
                      `Git could not read this project right now (${describeCause(error, "unknown error")}).`,
                      true,
                    );
            const notGit = forkError(
              "destination-unavailable",
              "New worktrees need a Git project.",
            );
            const resolved = yield* Effect.gen(function* () {
              if (chat) return yield* notGit;
              if (!(yield* pathExists(root))) {
                return yield* forkError(
                  "destination-unavailable",
                  "The project's folder no longer exists.",
                );
              }
              // Detects the repository without taking a Git that failed to run for "no Git".
              const isGit = yield* checkpoints.resolveCommit({ cwd: root, ref: "HEAD" }).pipe(
                Effect.as(true),
                Effect.catchTag("VcsUnsupportedOperationError", () => Effect.succeed(false)),
              );
              if (!isGit) return yield* notGit;
              const turn = input.boundary.turn;
              if (start.kind === "base-ref") {
                const baseCommit = yield* checkpoints.resolveCommit({
                  cwd: root,
                  ref: start.baseRef,
                });
                if (baseCommit === null) {
                  return yield* forkError(
                    "base-ref-invalid",
                    `Git could not find '${start.baseRef}' in this project.`,
                  );
                }
                return { baseCommit, checkpointCommit: null, baseRef: start.baseRef };
              }
              const checkpointRef = turn.checkpointRef;
              const unavailable = forkError(
                "checkpoint-unavailable",
                "This turn has no saved checkpoint that can start a worktree. Start from a branch or commit instead.",
              );
              if (
                turn.checkpointStatus !== "ready" ||
                checkpointRef === null ||
                !checkpointRef.startsWith(`${CHECKPOINT_REFS_PREFIX}/`)
              ) {
                return yield* unavailable;
              }
              // The checkpoint is laid on the source checkout's own current commit (checkpoint
              // commits have no parent). Another commit, such as the project root's, would be the
              // wrong base, so a removed source checkout leaves no checkpoint start.
              if ((yield* sourceCheckoutProblem(source, root)) !== null) {
                return yield* forkError(
                  "checkpoint-unavailable",
                  "The original thread's checkout was removed, so this turn's checkpoint cannot be placed on its commit. Start from a branch or commit instead.",
                );
              }
              const checkpointCommit = yield* checkpoints.resolveCommit({
                cwd: root,
                ref: checkpointRef,
              });
              const sourceHead = yield* checkpoints.resolveCommit({
                cwd: source.worktreePath ?? root,
                ref: "HEAD",
              });
              // The source commit must exist in the project repository the worktree is made in.
              const baseCommit =
                sourceHead === null
                  ? null
                  : yield* checkpoints.resolveCommit({ cwd: root, ref: sourceHead });
              if (checkpointCommit === null || baseCommit === null || baseCommit !== sourceHead) {
                return yield* unavailable;
              }
              return { baseCommit, checkpointCommit, baseRef: baseCommit };
            }).pipe(Effect.mapError(gitUnreadable));
            const { baseCommit, checkpointCommit, baseRef } = resolved;
            const turn = input.boundary.turn;
            const pins = forkPinRefs(identity.forkThreadId);
            yield* Effect.gen(function* () {
              yield* checkpoints.pinRef({ cwd: root, ref: pins.base, commit: baseCommit });
              if (checkpointCommit === null || turn.checkpointRef === null) return;
              yield* checkpoints.pinRef({
                cwd: root,
                ref: pins.checkpoint,
                commit: checkpointCommit,
              });
              // Refs are mutable: make sure the pinned snapshot is still this turn's checkpoint.
              const current = yield* turnRows.getByTurnId({
                threadId: source.id,
                turnId: input.boundary.turnId,
              });
              const still =
                Option.isSome(current) &&
                current.value.checkpointRef === turn.checkpointRef &&
                current.value.checkpointStatus === "ready" &&
                (yield* checkpoints.resolveCommit({ cwd: root, ref: turn.checkpointRef })) ===
                  checkpointCommit;
              if (!still) {
                return yield* forkError(
                  "boundary-stale",
                  "This turn's checkpoint changed while the fork was prepared. Choose a reply again.",
                );
              }
            }).pipe(
              Effect.onError(() =>
                checkpoints
                  .deleteCheckpointRefs({ cwd: root, checkpointRefs: [pins.base, pins.checkpoint] })
                  .pipe(Effect.ignoreCause({ log: true })),
              ),
              Effect.mapError((error) =>
                isForkRunError(error)
                  ? error
                  : forkError(
                      "preparation-failed",
                      `Git could not pin the fork's start commit (${describeCause(error, "unknown error")}).`,
                      true,
                    ),
              ),
            );
            const branch = identity.branch(
              resolveProjectPreferences({ settings: input.settings, project }).worktreeBranchPrefix
                .value,
            );
            return {
              kind: "new-worktree",
              worktreeId: identity.worktreeId,
              branch,
              start: start.kind,
              baseRef,
              repositoryRoot: root,
              baseCommit,
              baseCommitRef: pins.base,
              checkpointCommit,
              checkpointCommitRef: checkpointCommit === null ? null : pins.checkpoint,
            } satisfies ThreadForkCheckoutPlan;
          }
        }
      });

    /**
     * Pins where a Claude copy ends against the source transcript. A cutoff at the transcript's
     * tail is only kept when nothing can follow the boundary turn into it: no later turn (even
     * one without an id yet) and an idle session, both before the read and after it. The engine
     * records a turn's row before any reactor sends its prompt, so a prompt the read could have
     * seen shows up in the second read.
     */
    const pinClaudeProvider = (input: {
      readonly candidate: ClaudeNativeCandidate;
      readonly config: ProviderInstanceConfig;
      readonly boundary: ForkBoundary;
      readonly session: ForkBoundarySession | null;
      readonly turns: ReadonlyArray<ForkBoundaryTurn>;
      readonly sourceThreadId: ThreadId;
    }) =>
      Effect.gen(function* () {
        const pin = yield* nativeOps.pinClaudeCutoff({
          plan: input.candidate.plan,
          config: input.config,
          laterTurnIds: input.boundary.laterTurnIds,
        });
        let tailProven = false;
        if (
          pin.kind === "pinned" &&
          pin.atTail &&
          input.boundary.laterTurnIds.length === 0 &&
          !input.boundary.unidentifiedLaterTurns &&
          isSessionIdle(input.session)
        ) {
          const after = yield* sql.withTransaction(
            Effect.all({
              shell: snapshots.getThreadShellById(input.sourceThreadId),
              turns: turnRows.listByThreadId({ threadId: input.sourceThreadId }),
            }),
          );
          tailProven =
            Option.isSome(after.shell) &&
            isSessionIdle(after.shell.value.session) &&
            turnRowsFingerprint(after.turns) === turnRowsFingerprint(input.turns);
        }
        return pinClaudeForkPlan(input.candidate, pin, tailProven);
      });

    const accept = (request: ThreadForkInput, digest: string) =>
      Effect.gen(function* () {
        const identity = threadForkIdentity(request.forkKey);
        const createdAt = nowIso();
        // One read transaction: the boundary is resolved against a consistent source.
        const { shell, detail, turns } = yield* sql.withTransaction(
          Effect.all({
            shell: snapshots.getThreadShellById(request.sourceThreadId),
            detail: snapshots.getThreadDetailById(request.sourceThreadId),
            turns: turnRows.listByThreadId({ threadId: request.sourceThreadId }),
          }),
        );
        if (Option.isNone(shell) || Option.isNone(detail)) {
          return yield* forkError(
            "source-unavailable",
            "The original thread was deleted or moved to Trash.",
          );
        }
        const source = detail.value;
        const project = yield* snapshots.getProjectShellById(source.projectId);
        if (Option.isNone(project)) {
          return yield* forkError("source-unavailable", "The original thread's project is gone.");
        }
        if (isCheckpointRevertPending(source.activities, now().getTime())) {
          return yield* forkError(
            "source-busy",
            "The original thread is reverting to a checkpoint. Try again in a moment.",
            true,
          );
        }
        const session: ForkBoundarySession | null =
          source.session === null
            ? null
            : { activeTurnId: source.session.activeTurnId, status: source.session.status };
        const boundary = resolveForkBoundary({
          messages: source.messages,
          turns,
          session,
          messageId: request.sourceMessageId,
        });
        if (!boundary.ok) {
          return yield* forkError(
            boundary.reason,
            boundary.detail,
            boundary.reason === "source-busy",
          );
        }
        const settings = yield* serverSettings.getSettings;
        const checkout = yield* planCheckout({
          request,
          identity,
          settings,
          project: project.value,
          source: {
            id: source.id,
            title: source.title,
            worktreeId: source.worktreeId ?? null,
            worktreePath: source.worktreePath,
            branch: source.branch,
          },
          boundary,
        });
        // Until the row is written, a failure drops the commits the checkout plan pinned.
        const dropPins = () => deletePinRefs(checkout, identity.forkThreadId);
        const row = yield* Effect.gen(function* () {
          const instanceConfig =
            deriveProviderInstanceConfigMap(settings)[source.modelSelection.instanceId];
          const decision = planForkProvider({
            instanceId: source.modelSelection.instanceId,
            config: instanceConfig,
            binding: Option.getOrUndefined(yield* directory.getBinding(source.id)),
            boundary,
          });
          const provider: ThreadForkProviderPlan =
            decision.kind !== "claude-candidate"
              ? decision
              : instanceConfig === undefined
                ? { kind: "handoff", reason: "no-native-session" }
                : yield* pinClaudeProvider({
                    candidate: decision,
                    config: instanceConfig,
                    boundary,
                    session,
                    turns,
                    sourceThreadId: source.id,
                  });
          const projectId = checkout.kind === "new-chat" ? checkout.projectId : source.projectId;
          const publication = buildForkPublication({
            forkThreadId: identity.forkThreadId,
            commandId: identity.commandId("publish"),
            projectId,
            createdAt,
            source: {
              threadId: source.id,
              title: source.title,
              modelSelection: source.modelSelection,
              runtimeMode: source.runtimeMode,
              interactionMode: source.interactionMode,
              tokenMode: source.tokenMode,
            },
            boundary,
            turns,
            proposedPlans: source.proposedPlans,
            activities: source.activities,
            outcome: plannedOutcome(checkout, provider),
          });
          return {
            forkKey: request.forkKey,
            requestDigest: digest,
            forkThreadId: identity.forkThreadId,
            sourceThreadId: source.id,
            sourceMessageId: boundary.boundaryMessage.id,
            destinationKind: request.destination.kind,
            phase: "accepted",
            plan: {
              schemaVersion: 1,
              forkThreadId: identity.forkThreadId,
              projectId,
              sourceProjectId: source.projectId,
              sourceThreadId: source.id,
              sourceMessageId: boundary.boundaryMessage.id,
              sourceTurnId: boundary.turnId,
              sourceTitle: source.title.trim() || "Untitled",
              destination: request.destination,
              checkout,
              provider,
              attachments: publication.attachments,
              command: publication.command,
              notices: publication.historyNotices,
            },
            checkout: null,
            provider: null,
            attachments: null,
            result: null,
            error: null,
            createdAt,
            updatedAt: createdAt,
          } satisfies ThreadForkLedgerRow;
        }).pipe(Effect.onError(dropPins));
        if (yield* ledger.insertIfAbsent(row).pipe(Effect.onError(dropPins))) return row;
        // The key was accepted meanwhile (another process): continue with its row.
        const existing = yield* readRow(request.forkKey);
        if (existing === undefined) return yield* interruptedRunError();
        if (existing.requestDigest !== digest) return yield* conflictError();
        return existing;
      }).pipe(
        Effect.catch((error) =>
          isForkRunError(error)
            ? Effect.fail(error)
            : Effect.logWarning("thread fork acceptance failed", { cause: error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    forkError(
                      "source-busy",
                      "The original thread could not be read right now. Try again in a moment.",
                      true,
                    ),
                  ),
                ),
              ),
        ),
      );

    // -------------------------------------------------------------------------------------------
    // Cleanup of what a fork created.

    /** Removes a native copy the row records. Best effort: a failure is logged with its id. */
    const removeNativeCopy = (
      row: ThreadForkLedgerRow,
      nativeThreadId: string,
      copy: ThreadForkOwnedNativeCopy,
    ) =>
      Effect.gen(function* () {
        const plan = row.plan.provider;
        if (plan.kind !== "native") return;
        const settings = yield* Effect.option(serverSettings.getSettings);
        yield* nativeOps.removeCopy({
          plan,
          config: Option.isSome(settings)
            ? deriveProviderInstanceConfigMap(settings.value)[plan.instanceId]
            : undefined,
          nativeThreadId,
          copy,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("thread fork could not remove its native copy", {
                forkKey: row.forkKey,
                nativeThreadId,
                cause: Cause.pretty(cause),
              }),
        ),
      );

    /** The copy a handoff record proves was created but never used, if any. */
    const orphanOf = (row: ThreadForkLedgerRow) =>
      row.provider?.kind === "handoff" ? row.provider.orphan : undefined;

    /** Git made this folder for a linked worktree: its `.git` is a file naming the repository. */
    const isLinkedWorktreeFolder = (folder: string) =>
      fileSystem.readFileString(paths.join(folder, ".git")).pipe(
        Effect.map((content) => content.startsWith("gitdir:")),
        Effect.catchTag("PlatformError", (error) =>
          // Nothing there, or not a file: not a linked worktree.
          error.reason._tag === "NotFound" || error.reason._tag === "BadResource"
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      );

    /**
     * The fork's repository as it is now: provably gone (its folder no longer exists, or it is no
     * longer a Git repository), or where `branch` points in it (null: no such branch). These do
     * not pass. Git that could not run, or a folder that could not be checked, fails instead, so
     * the run stops retryably.
     */
    const forkRepository = (plan: WorktreeCheckoutPlan, branch: string) =>
      Effect.gen(function* () {
        if (!(yield* pathExists(plan.repositoryRoot))) {
          return { gone: "The project's folder no longer exists." } as const;
        }
        return yield* checkpoints
          .resolveCommit({ cwd: plan.repositoryRoot, ref: `refs/heads/${branch}` })
          .pipe(
            Effect.map((branchTip) => ({ branchTip }) as const),
            Effect.catchTag("VcsUnsupportedOperationError", () =>
              Effect.succeed({ gone: "The project is no longer a Git repository." } as const),
            ),
          );
      });

    /**
     * Why a new worktree can no longer be made for the fork, or null: its project moved, or its
     * repository is gone. Checked before anything is reserved or created, and again before Git
     * creates the checkout.
     */
    const worktreeDestinationProblem = (
      plan: WorktreeCheckoutPlan,
      project: OrchestrationProjectShell,
    ) =>
      Effect.gen(function* () {
        if (project.workspaceRoot !== plan.repositoryRoot) {
          return { problem: "The project moved since the fork was requested." } as const;
        }
        const repository = yield* forkRepository(plan, plan.branch);
        return "gone" in repository
          ? ({ problem: repository.gone } as const)
          : ({ problem: null, branchTip: repository.branchTip } as const);
      });

    /**
     * Removes a new worktree this fork recorded: the checkout at its path, and its branch only
     * while the branch still points at the fork's base commit. Git created the branch there and
     * only a checkpoint restore (which never commits) ran since, so a branch anyone else made or
     * moved under the name stays. Once the repository itself is provably gone (its folder, or
     * its Git data, and its branch and refs with it), Git cannot remove the checkout, so the
     * folder Git made for the fork is removed directly: its path was proven free when the fork
     * recorded it, and a folder there that is not a linked worktree stays.
     */
    const removeRecordedWorktree = (
      plan: WorktreeCheckoutPlan,
      record: WorktreeCheckoutRecord,
      operation: string,
    ) =>
      Effect.gen(function* () {
        const repository = yield* forkRepository(plan, record.branch);
        if ("gone" in repository) {
          if (yield* isLinkedWorktreeFolder(record.worktreePath)) {
            yield* fileSystem.remove(record.worktreePath, { recursive: true, force: true });
          }
          return;
        }
        const tip = repository.branchTip;
        const ownsBranch = tip !== null && tip === plan.baseCommit;
        if (tip !== null && !ownsBranch) {
          yield* Effect.logWarning("thread fork keeps a branch it did not create", {
            branch: record.branch,
            repositoryRoot: plan.repositoryRoot,
          });
        }
        yield* removeOwnedCheckout(managedCheckoutDeps, {
          operation,
          repositoryRoot: plan.repositoryRoot,
          owned: { worktreePath: record.worktreePath, branch: ownsBranch ? record.branch : null },
        });
      });

    /**
     * Removes what the row records as created by this fork. A worktree that cannot be removed
     * fails the cleanup (the row is then not recorded as failed, so a later attempt finishes it);
     * native copies, a chat folder, attachment copies and pins are best effort. `keepPins` keeps
     * the pinned start commits for a retry of a failure that can be retried.
     */
    const cleanupOwned = (row: ThreadForkLedgerRow, keepPins = false) =>
      Effect.gen(function* () {
        const { plan } = row;
        const provider = row.provider;
        if (provider?.kind === "native") {
          yield* removeNativeCopy(row, provider.nativeThreadId, provider.ownedCopy);
        }
        const orphan = orphanOf(row);
        if (orphan !== undefined) yield* removeNativeCopy(row, orphan.nativeThreadId, orphan.copy);
        const checkout = row.checkout;
        if (checkout?.kind === "new-worktree" && plan.checkout.kind === "new-worktree") {
          yield* removeRecordedWorktree(plan.checkout, checkout, "threads.fork.cleanup").pipe(
            Effect.mapError(() =>
              interruptedRunError("Cleaning up the fork's worktree failed. Retry to finish."),
            ),
          );
        }
        if (checkout?.kind === "new-chat") {
          yield* releasePreparedChatFolder(chatDeps(row.forkKey), checkout);
        }
        if (plan.attachments.length > 0) {
          yield* Effect.tryPromise(() =>
            deleteThreadAttachmentFiles({
              attachmentsDir: config.attachmentsDir,
              threadId: plan.forkThreadId,
              attachmentIds: plan.attachments.map((copy) => copy.attachmentId),
            }),
          ).pipe(Effect.ignoreCause({ log: true }));
        }
        if (!keepPins) yield* deletePinRefs(plan.checkout, plan.forkThreadId);
      });

    /** Cleans up what the fork owns, then records and returns a permanent failure. */
    const failPermanently = (row: ThreadForkLedgerRow, error: ForkRunError) =>
      Effect.gen(function* () {
        yield* cleanupOwned(row);
        yield* advance(row, "failed", { error: failureOf(error) }, !error.retryable);
        return yield* error;
      });

    /** The fork's project; a project deleted since acceptance fails the fork for good. */
    const forkProject = (row: ThreadForkLedgerRow) =>
      requireProject(row.plan.projectId).pipe(
        Effect.catch((error) =>
          isForkRunError(error) ? failPermanently(row, error) : Effect.fail(error),
        ),
      );

    // -------------------------------------------------------------------------------------------
    // Run steps. Each takes the current row and returns it after its transition.

    const createWorktree = (
      row: ThreadForkLedgerRow,
      plan: WorktreeCheckoutPlan,
      worktreePath: string,
    ) =>
      Effect.gen(function* () {
        const settings = yield* loadSettings;
        const project = yield* requireProject(row.plan.projectId);
        const destination = yield* worktreeDestinationProblem(plan, project);
        if (destination.problem !== null) {
          return yield* forkError("destination-unavailable", destination.problem);
        }
        const created = yield* createManagedCheckout(managedCheckoutDeps, {
          operation: "threads.fork",
          project,
          settings,
          initialName: row.plan.command.title,
          branchName: plan.branch,
          refName: plan.baseCommit,
          newRefName: plan.branch,
          fetchOrigin: false,
          path: worktreePath,
        });
        if (plan.checkpointCommitRef !== null) {
          const restored = yield* checkpoints.restoreCheckpoint({
            cwd: created.worktreePath,
            checkpointRef: plan.checkpointCommitRef,
          });
          if (!restored) {
            return yield* forkError(
              "checkpoint-unavailable",
              "The turn's checkpoint could not be restored into the new worktree.",
            );
          }
        }
        const submoduleNotice = worktreeSubmoduleSetupNotice(created.submoduleInitialization);
        return {
          worktreePath: created.worktreePath,
          ...(submoduleNotice === null
            ? {}
            : { submoduleNotice: truncateUnicodeSafe(submoduleNotice, NOTICE_MAX_CHARS) }),
        };
      });

    /** Creates the recorded worktree; a failure removes what it made and fails the row. */
    const prepareWorktree = (row: ThreadForkLedgerRow, plan: WorktreeCheckoutPlan) =>
      Effect.gen(function* () {
        const record = row.checkout;
        if (record?.kind !== "new-worktree") return yield* interruptedRunError();
        const created = yield* Effect.exit(createWorktree(row, plan, record.worktreePath));
        if (Exit.isSuccess(created)) {
          yield* runPoint("checkout-created", row);
          return yield* advance(row, "checkout-ready", {
            checkout: { ...record, ...created.value },
          });
        }
        if (Cause.hasInterrupts(created.cause)) return yield* Effect.failCause(created.cause);
        const failure = Cause.squash(created.cause);
        yield* Effect.logWarning("thread fork worktree preparation failed", {
          forkKey: row.forkKey,
          cause: Cause.pretty(created.cause),
        });
        const cleaned = yield* Effect.exit(
          removeRecordedWorktree(plan, record, "threads.fork.cleanup"),
        );
        if (Exit.isFailure(cleaned)) {
          // Keep the record: a retry resumes here and removes the checkout before recreating it.
          return yield* interruptedRunError(
            "Preparing the worktree failed and could not be cleaned up yet. Retry to finish.",
          );
        }
        const error = isForkRunError(failure)
          ? failure.reason === "checkpoint-unavailable" ||
            failure.reason === "destination-unavailable"
            ? failure
            : forkError(failure.reason, failure.message, true)
          : forkError(
              "preparation-failed",
              `Preparing the worktree failed: ${describeCause(failure, "Git reported an error.")}`,
              true,
            );
        // A retry starts from the pinned commits again; a fork that cannot be retried releases them.
        if (!error.retryable) yield* deletePinRefs(plan, row.plan.forkThreadId);
        yield* advance(
          row,
          "failed",
          { checkout: null, error: failureOf(error) },
          !error.retryable,
        );
        return yield* error;
      });

    /**
     * The path for the fork's new worktree, reserved once per row: a run that stopped before it
     * recorded the path left it reserved, and the next run here reuses it. A worktree root or
     * path the settings or the workspace policy refuse fails the fork for good; anything else
     * (reserving the path in the database, a folder that could not be read) stops it retryably.
     */
    const reserveWorktreePath = (
      row: ThreadForkLedgerRow,
      plan: WorktreeCheckoutPlan,
      project: OrchestrationProjectShell,
    ) =>
      Effect.gen(function* () {
        const reserved = reservedWorktreePaths.get(row.forkKey);
        if (reserved !== undefined) return reserved;
        const settings = yield* loadSettings;
        const worktreePath = yield* resolveManagedCheckoutPath(managedCheckoutDeps, {
          operation: "threads.fork",
          project,
          settings,
          initialName: row.plan.command.title,
          branchName: plan.branch,
        }).pipe(
          Effect.catch((error) => {
            const detail = error.detail;
            return isManagedCheckoutPathRefusal(error)
              ? failPermanently(
                  row,
                  forkError(
                    "destination-unavailable",
                    `The new worktree cannot be created where this project's worktrees go: ${detail}`,
                  ),
                )
              : Effect.fail(
                  interruptedRunError(
                    `Ryco could not reserve a folder for the new worktree (${detail}). Retry in a moment.`,
                  ),
                );
          }),
        );
        reservedWorktreePaths.set(row.forkKey, worktreePath);
        return worktreePath;
      });

    const stepAccepted = (row: ThreadForkLedgerRow) =>
      Effect.gen(function* () {
        const plan = row.plan.checkout;
        switch (plan.kind) {
          case "current-checkout": {
            const project = yield* forkProject(row);
            if (!(yield* pathExists(plan.worktreePath ?? project.workspaceRoot))) {
              return yield* failPermanently(
                row,
                forkError(
                  "destination-unavailable",
                  "The original thread's folder no longer exists.",
                ),
              );
            }
            return yield* advance(row, "checkout-ready", {
              checkout: {
                kind: "current-checkout",
                worktreeId: plan.worktreeId,
                worktreePath: plan.worktreePath,
                branch: plan.branch,
              },
            });
          }
          case "new-chat": {
            const prepared = yield* prepareChatProject(chatDeps(row.forkKey), {
              chat: { projectId: plan.projectId, titleSeed: plan.titleSeed },
              createThread: {
                projectId: plan.projectId,
                title: row.plan.command.title,
                modelSelection: row.plan.command.modelSelection,
                runtimeMode: row.plan.command.runtimeMode,
                interactionMode: row.plan.command.interactionMode,
                branch: null,
                worktreePath: null,
                createdAt: row.plan.command.createdAt,
              },
            }).pipe(
              Effect.catch((error) =>
                error.reason === "chat-project-retired"
                  ? failPermanently(
                      row,
                      forkError("preparation-failed", "The new chat could not be created."),
                    )
                  : Effect.fail(
                      forkError(
                        "preparation-failed",
                        `The new chat could not be created: ${error.message}`,
                        true,
                      ),
                    ),
              ),
            );
            return yield* advance(row, "checkout-ready", {
              checkout: {
                kind: "new-chat",
                projectId: prepared.projectId,
                folder: prepared.folder,
                createdFolder: prepared.createdFolder,
              },
            });
          }
          case "new-worktree": {
            const project = yield* forkProject(row);
            // The destination is checked before anything is reserved: a project that moved or a
            // repository that is gone does not come back, so the fork fails for good instead of
            // being driven again and again.
            const destination = yield* worktreeDestinationProblem(plan, project);
            if (destination.problem !== null) {
              return yield* failPermanently(
                row,
                forkError("destination-unavailable", destination.problem),
              );
            }
            // Nothing may exist under the fork's names yet: whatever exists later is this fork's.
            if (destination.branchTip !== null) {
              return yield* failPermanently(
                row,
                forkError(
                  "preparation-failed",
                  `A branch named '${plan.branch}' already exists, so this fork cannot create its worktree.`,
                ),
              );
            }
            const worktreePath = yield* reserveWorktreePath(row, plan, project);
            if (yield* pathExists(worktreePath)) {
              return yield* failPermanently(
                row,
                forkError(
                  "preparation-failed",
                  "The new worktree's folder already exists, so this fork cannot create its worktree.",
                ),
              );
            }
            const recorded = yield* advance(row, "checkout-preparing", {
              checkout: {
                kind: "new-worktree",
                worktreeId: plan.worktreeId,
                branch: plan.branch,
                worktreePath,
              },
            });
            reservedWorktreePaths.delete(row.forkKey);
            yield* runPoint("checkout-preparing", recorded);
            return yield* prepareWorktree(recorded, plan);
          }
        }
      });

    /** A run stopped after recording the checkout: remove whatever it made and start over. */
    const stepCheckoutPreparing = (row: ThreadForkLedgerRow) =>
      Effect.gen(function* () {
        const plan = row.plan.checkout;
        const record = row.checkout;
        if (plan.kind !== "new-worktree" || record?.kind !== "new-worktree") {
          return yield* interruptedRunError();
        }
        yield* removeRecordedWorktree(plan, record, "threads.fork.resume").pipe(
          Effect.mapError(() =>
            interruptedRunError(
              "An interrupted worktree could not be removed yet. Retry to finish.",
            ),
          ),
        );
        return yield* prepareWorktree(row, plan);
      });

    const handOff = (
      row: ThreadForkLedgerRow,
      reason: HandoffProviderRecord["reason"],
      detail: string | null,
      orphan?: HandoffProviderRecord["orphan"],
    ) =>
      advance(row, "provider-ready", {
        provider: { kind: "handoff", reason, detail, ...(orphan === undefined ? {} : { orphan }) },
      });

    /**
     * The directory the fork runs in, canonical; undefined once it provably does not exist. Any
     * other filesystem error stops the run retryably, like `pathExists`, instead of giving up
     * the native copy for good.
     */
    const forkCwd = (row: ThreadForkLedgerRow) =>
      Effect.gen(function* () {
        const record = row.checkout;
        if (record === null) return undefined;
        const cwd =
          record.kind === "new-chat"
            ? record.folder
            : (record.worktreePath ?? (yield* forkProject(row)).workspaceRoot);
        return yield* fileSystem
          .realPath(cwd)
          .pipe(
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound" || error.reason._tag === "BadResource"
                ? Effect.succeed(undefined)
                : Effect.fail(unreadableFolder(error)),
            ),
          );
      });

    const stepCheckoutReady = (row: ThreadForkLedgerRow) =>
      Effect.gen(function* () {
        const plan = row.plan.provider;
        if (plan.kind === "handoff") return yield* handOff(row, plan.reason, null);
        const targetCwd = yield* forkCwd(row);
        if (targetCwd === undefined) {
          return yield* handOff(row, "native-fork-failed", "The fork's folder is unavailable.");
        }
        const settings = yield* loadSettings;
        const instanceConfig = deriveProviderInstanceConfigMap(settings)[plan.instanceId];
        if (
          instanceConfig === undefined ||
          instanceConfig.enabled === false ||
          instanceConfig.driver !== plan.driver ||
          nativeForkConfigFingerprint(instanceConfig) !== plan.configFingerprint
        ) {
          return yield* handOff(
            row,
            "native-fork-failed",
            "The provider configuration changed after the fork was requested.",
          );
        }
        // Claimed before the call: whatever happens next, this key never forks natively again.
        const claimed = yield* advance(row, "provider-forking", {
          provider: {
            kind: "forking",
            driver: plan.driver,
            instanceId: plan.instanceId,
            targetCwd,
            startedAt: nowIso(),
          },
        });
        yield* runPoint("provider-forking", claimed);
        /** Records what the native call returned. */
        const record = (outcome: Exit.Exit<NativeForkOutcome, NativeForkUncertain>) =>
          Effect.gen(function* () {
            if (Exit.isFailure(outcome)) {
              if (Cause.hasInterruptsOnly(outcome.cause)) {
                return yield* Effect.failCause(outcome.cause);
              }
              const cause = Cause.squash(outcome.cause);
              // A copy whose id the provider returned is ours even unverified: record it so
              // cleanup can remove it, instead of leaving it behind untraced.
              const uncertain = Schema.is(NativeForkUncertain)(cause) ? cause : undefined;
              const orphan =
                uncertain?.nativeThreadId !== undefined && uncertain.ownedCopy !== undefined
                  ? { nativeThreadId: uncertain.nativeThreadId, copy: uncertain.ownedCopy }
                  : undefined;
              yield* Effect.logWarning("native fork outcome is uncertain", {
                forkKey: row.forkKey,
                nativeThreadId: orphan?.nativeThreadId,
                cause: Cause.pretty(outcome.cause),
              });
              return yield* handOff(
                claimed,
                "native-fork-uncertain",
                describeCause(cause, "The provider did not confirm the copy."),
                orphan,
              ).pipe(
                // Not recorded: a later run hands off without knowing this copy, so remove it
                // now rather than leave it behind untraced (as for a confirmed copy below).
                Effect.onError(() =>
                  orphan === undefined
                    ? Effect.void
                    : removeNativeCopy(claimed, orphan.nativeThreadId, orphan.copy),
                ),
              );
            }
            const result = outcome.value;
            switch (result.kind) {
              case "forked":
                return yield* advance(claimed, "provider-ready", {
                  provider: {
                    kind: "native",
                    driver: plan.driver,
                    instanceId: plan.instanceId,
                    nativeThreadId: result.nativeThreadId,
                    resumeCursor:
                      plan.driver === "codex"
                        ? codexForkResumeCursor(result.nativeThreadId)
                        : claudeForkResumeCursor({
                            forkThreadId: row.forkThreadId,
                            nativeSessionId: result.nativeThreadId,
                            inheritedUserTurnCount: plan.inheritedUserTurnCount,
                          }),
                    cwd: targetCwd,
                    runtimeSessionId: threadForkIdentity(row.forkKey).runtimeSessionId,
                    ownedCopy: result.ownedCopy,
                  },
                }).pipe(
                  // Not recorded: a later run hands off without knowing this verified copy, so
                  // remove it now rather than leave it behind untraced.
                  Effect.onError(() =>
                    removeNativeCopy(claimed, result.nativeThreadId, result.ownedCopy),
                  ),
                );
              case "turn-not-in-session":
                return yield* handOff(claimed, "turn-not-in-native-session", null);
              case "refused":
                return yield* handOff(claimed, "native-fork-failed", result.detail);
            }
          });
        // The call itself stays interruptible: a run stopped during it is uncertain by design.
        // Once it returned, its outcome is recorded without interruption (a shutdown waits for
        // the write), so a copy the provider confirmed is never dropped between the call and the
        // ledger. Only a hard crash in that moment still loses its id; the run then hands off.
        return yield* Effect.uninterruptibleMask((restore) =>
          restore(
            nativeOps.fork({
              forkThreadId: row.forkThreadId,
              plan,
              config: instanceConfig,
              targetCwd,
            }),
          ).pipe(Effect.exit, Effect.flatMap(record)),
        );
      });

    /** A native call may have been in flight when the run stopped: never repeat it. */
    const stepProviderForking = (row: ThreadForkLedgerRow) =>
      handOff(
        row,
        "native-fork-uncertain",
        "The run stopped while the provider was copying the conversation.",
      );

    const linkAttachments = (row: ThreadForkLedgerRow) =>
      Effect.gen(function* () {
        const linked: string[] = [];
        for (const copy of row.plan.attachments) {
          const result = yield* Effect.exit(
            Effect.tryPromise(() =>
              materializeInheritedAttachment({
                attachmentsDir: config.attachmentsDir,
                forkThreadId: row.forkThreadId,
                attachment: copy.source,
              }),
            ),
          );
          if (Exit.isSuccess(result)) {
            linked.push(copy.attachmentId);
          } else {
            yield* Effect.logWarning("inherited attachment was not carried over", {
              forkKey: row.forkKey,
              attachmentId: copy.source.id,
              cause: Cause.pretty(result.cause),
            });
          }
        }
        return yield* advance(row, "provider-ready", { attachments: { attachmentIds: linked } });
      });

    /**
     * Why the fork's destination can no longer take the publication, or null: its project was
     * deleted, its folder is gone, or the shared source checkout was removed. These do not pass.
     */
    const destinationProblem = (row: ThreadForkLedgerRow, command: ThreadForkCreateCommand) =>
      Effect.gen(function* () {
        const project = yield* snapshots.getProjectShellById(command.projectId);
        if (Option.isNone(project)) return "The fork's project no longer exists.";
        if (!(yield* pathExists(command.worktreePath ?? project.value.workspaceRoot))) {
          return "The fork's folder no longer exists.";
        }
        const plan = row.plan.checkout;
        if (
          plan.kind === "current-checkout" &&
          plan.worktreeId !== null &&
          snapshots.getWorktreeShellById !== undefined
        ) {
          const worktree = yield* snapshots.getWorktreeShellById(plan.worktreeId);
          if (Option.isNone(worktree) || worktree.value.checkoutRemovedAt != null) {
            return "The original thread's checkout was removed.";
          }
        }
        return null;
      });

    const publish = (row: ThreadForkLedgerRow) =>
      Effect.gen(function* () {
        const { command } = finalPublication(row);
        const provider = row.provider;
        const native = provider?.kind === "native" ? provider : null;
        const admission = Effect.gen(function* () {
          const problem = yield* destinationProblem(row, command);
          if (problem !== null) {
            return yield* new OrchestrationCommandAdmissionError({ detail: problem });
          }
          if (native !== null) {
            yield* directory.upsert({
              threadId: command.threadId,
              provider: ProviderDriverKind.make(native.driver),
              providerInstanceId: native.instanceId,
              runtimeSessionId: native.runtimeSessionId,
              status: "stopped",
              runtimeMode: command.runtimeMode,
              resumeCursor: native.resumeCursor,
              runtimePayload: { cwd: native.cwd },
            });
          }
        });
        const dispatched = yield* Effect.exit(
          engine.dispatch(command, {
            withCommitLease: serverSettings.withSettingsSnapshot,
            // Runs in the engine's serialized fiber: the binding and the publication commit
            // together, after the destination is revalidated.
            admit: (commit) =>
              sql
                .withTransaction(
                  admission.pipe(
                    Effect.mapError((error) =>
                      Schema.is(OrchestrationCommandAdmissionError)(error)
                        ? error
                        : new OrchestrationCommandAdmissionError({
                            detail: "The fork could not be published right now.",
                          }),
                    ),
                    Effect.andThen(commit),
                  ),
                )
                .pipe(
                  Effect.catchTag("SqlError", () =>
                    Effect.fail(
                      new OrchestrationCommandAdmissionError({
                        detail: "The fork's publication was interrupted.",
                      }),
                    ),
                  ),
                ),
          }),
        );
        if (Exit.isSuccess(dispatched)) {
          yield* runPoint("publish-committed", row);
          const published = yield* advance(row, "published", {});
          yield* runPoint("published", published);
          return published;
        }
        if (Cause.hasInterruptsOnly(dispatched.cause)) {
          return yield* Effect.failCause(dispatched.cause);
        }
        const failure = Cause.squash(dispatched.cause);
        if (
          Schema.is(OrchestrationCommandInvariantError)(failure) ||
          Schema.is(OrchestrationCommandPreviouslyRejectedError)(failure)
        ) {
          return yield* failPermanently(
            row,
            forkError("preparation-failed", `The fork could not be published: ${failure.detail}`),
          );
        }
        if (Schema.is(OrchestrationCommandAdmissionError)(failure)) {
          // Refused without a receipt. A destination that is gone never comes back: release what
          // the fork made. Anything else (a relocation or cleanup in progress, an interrupted
          // write) keeps the recorded phase for a retry.
          const problem = yield* destinationProblem(row, command);
          if (problem !== null) {
            return yield* failPermanently(row, forkError("destination-unavailable", problem));
          }
          return yield* interruptedRunError(
            `The fork could not be published yet (${failure.detail}). Retry to finish it.`,
          );
        }
        yield* Effect.logWarning("thread fork publication failed", {
          forkKey: row.forkKey,
          cause: Cause.pretty(dispatched.cause),
        });
        return yield* interruptedRunError();
      });

    const stepProviderReady = (row: ThreadForkLedgerRow) =>
      Effect.gen(function* () {
        const linked =
          row.attachments === null && row.plan.attachments.length > 0
            ? yield* linkAttachments(row)
            : row;
        yield* runPoint("provider-ready", linked);
        return yield* publish(linked);
      });

    /** Starts the project's setup script in a new worktree when its preference says so. */
    const launchWorktreeSetup = (row: ThreadForkLedgerRow, worktreePath: string) =>
      Effect.gen(function* () {
        const settings = yield* Effect.option(serverSettings.getSettings);
        const project = yield* Effect.option(snapshots.getProjectShellById(row.plan.projectId));
        const projectShell = Option.flatten(project);
        if (
          Option.isSome(settings) &&
          Option.isSome(projectShell) &&
          resolveProjectPreferences({ settings: settings.value, project: projectShell.value })
            .runSetupScript.value
        ) {
          yield* launchSetupScriptForWorktreeInBackground(
            { projectSetupScriptRunner, appendSetupScriptActivity },
            {
              threadId: row.forkThreadId,
              projectId: projectShell.value.id,
              projectCwd: projectShell.value.workspaceRoot,
              worktreePath,
            },
          );
        }
      });

    /**
     * Post-publication work, then the stored result. The repeatable steps run first; a run that
     * stops before `completed` is recorded leaves them to the next run. The setup script starts
     * only after `completed` is recorded, by the run that recorded it, and without interruption
     * in between, so it starts at most once: a re-driven or recovered `published` row never
     * starts it a second time, possibly while the fork's agent already works in the worktree.
     * The trade-off: a hard crash right after that write means it never starts.
     */
    const stepPublished = (row: ThreadForkLedgerRow) =>
      Effect.gen(function* () {
        const { result } = finalPublication(row);
        // The fork never uses a copy it could not verify; try once more to remove it.
        const orphan = orphanOf(row);
        if (orphan !== undefined) yield* removeNativeCopy(row, orphan.nativeThreadId, orphan.copy);
        yield* deletePinRefs(row.plan.checkout, row.plan.forkThreadId);
        const record = row.checkout;
        return yield* Effect.uninterruptible(
          advance(row, "completed", { result }, true).pipe(
            // Best effort: the fork is created by now, whatever happens here.
            Effect.tap(() =>
              record?.kind === "new-worktree"
                ? launchWorktreeSetup(row, record.worktreePath).pipe(
                    Effect.andThen(refreshGitStatus(record.worktreePath)),
                    Effect.ignoreCause({ log: true }),
                  )
                : Effect.void,
            ),
          ),
        );
      });

    /** Advances a row until it completes or fails. */
    const drive = (initial: ThreadForkLedgerRow) =>
      Effect.gen(function* () {
        let row = initial;
        // Each step moves at least one phase forward; the bound only guards against a bug.
        for (let steps = 0; steps < 16; steps++) {
          switch (row.phase) {
            case "accepted":
              row = yield* stepAccepted(row);
              break;
            case "checkout-preparing":
              row = yield* stepCheckoutPreparing(row);
              break;
            case "checkout-ready":
              row = yield* stepCheckoutReady(row);
              break;
            case "provider-forking":
              row = yield* stepProviderForking(row);
              break;
            case "provider-ready":
              row = yield* stepProviderReady(row);
              break;
            case "published":
              row = yield* stepPublished(row);
              break;
            case "completed":
              if (row.result === null) return yield* interruptedRunError();
              return row.result;
            case "failed":
              return yield* errorOf(row.error ?? failureOf(interruptedRunError()));
          }
        }
        return yield* interruptedRunError();
      });

    /** A retryable failure nobody retried within the retry window. */
    const isAbandonedRetry = (row: ThreadForkLedgerRow) =>
      row.phase === "failed" &&
      row.error?.retryable === true &&
      Date.parse(row.updatedAt) < now().getTime() - THREAD_FORK_RETRY_WINDOW_MS;

    /**
     * Settles an abandoned retry for good, then releases its pinned commits. The settle is fenced
     * on the row as it was read: a retry that touched the row since (even one that failed again)
     * keeps the row and its pins.
     */
    const expireRetry = (row: ThreadForkLedgerRow) =>
      Effect.gen(function* () {
        if (row.error === null) return;
        const settled = yield* Effect.exit(
          advance(
            row,
            "failed",
            {
              error: {
                reason: row.error.reason,
                message: "This fork stopped and was not retried in time. Fork again.",
                retryable: false,
              },
            },
            true,
            true,
          ),
        );
        if (Exit.isSuccess(settled)) yield* deletePinRefs(row.plan.checkout, row.forkThreadId);
      });

    /**
     * Whether the node settles a key instead of driving it again: its runs on this node kept
     * stopping with the fork unfinished, `redriveLimit` times in a row, or a few times once the
     * fork has not advanced for `THREAD_FORK_STALLED_AFTER_MS`.
     */
    const givesUp = (row: ThreadForkLedgerRow) => {
      const stops = redrives.get(row.forkKey)?.stops ?? 0;
      return (
        stops >= redriveLimit ||
        (stops >= THREAD_FORK_STALLED_MIN_STOPS &&
          Date.parse(row.updatedAt) <= now().getTime() - THREAD_FORK_STALLED_AFTER_MS)
      );
    };

    /**
     * Settles a fork the node could not finish (`givesUp`), so its key stops reporting `running`:
     * removes what the fork created, then records a failure. Before any native call (`accepted`,
     * `checkout-preparing`, `checkout-ready`) a retry may start it again, so its pinned commits
     * stay (the retry window releases them); from the native call on it cannot, so the provider is
     * never asked twice for one key. A fork that is published (or whose publication committed) is
     * created and only completes, so it is driven instead. A cleanup that fails keeps the row
     * unfinished, and the node tries again later.
     */
    const settleStalled = (row: ThreadForkLedgerRow) =>
      Effect.gen(function* () {
        if (row.phase === "published") return yield* drive(row);
        if (
          row.phase === "provider-ready" &&
          Option.isSome(yield* snapshots.getThreadShellById(row.forkThreadId))
        ) {
          return yield* drive(row);
        }
        const retryable =
          row.phase === "accepted" ||
          row.phase === "checkout-preparing" ||
          row.phase === "checkout-ready";
        const error = forkError(
          "preparation-failed",
          retryable
            ? "The fork could not be finished, so Ryco stopped trying and removed what it had created. Retry to start it again."
            : "The fork could not be finished, so Ryco stopped trying and removed what it had created. Fork again.",
          retryable,
        );
        yield* Effect.logWarning("thread fork kept stopping; settling it", {
          forkKey: row.forkKey,
          phase: row.phase,
          stops: redrives.get(row.forkKey)?.stops ?? 0,
        });
        yield* cleanupOwned(row, retryable);
        yield* advance(row, "failed", { error: failureOf(error) }, !retryable);
        return yield* error;
      });

    /**
     * One attempt for a key: accept it when new, otherwise answer, retry or resume its row.
     * Answers (a replay, a conflict, a settled failure) never wait for a permit; only work does.
     * A run the node starts itself settles the fork instead once it `givesUp`.
     */
    const attempt = (forkKey: string, request: ThreadForkInput | null, digest: string | null) =>
      Effect.gen(function* () {
        const existing = yield* readRow(forkKey);
        if (existing !== undefined && digest !== null && existing.requestDigest !== digest) {
          return yield* conflictError();
        }
        if (existing?.phase === "completed") {
          if (existing.result === null) return yield* interruptedRunError();
          const live = yield* snapshots.getThreadShellById(existing.forkThreadId);
          if (Option.isNone(live)) {
            return yield* forkError(
              "deleted",
              "This fork was created earlier but has since been deleted.",
            );
          }
          return { ...existing.result, replayed: true };
        }
        if (existing !== undefined && isAbandonedRetry(existing)) {
          // The retry window passed, however long this node has been running: settle the fork
          // (unless a sweep just did) and answer with that.
          yield* expireRetry(existing);
          const settled = yield* readRow(forkKey);
          return yield* settled?.phase === "failed" && settled.error !== null
            ? errorOf(settled.error)
            : interruptedRunError();
        }
        // Only a request retries a failed fork; the node's own runs leave it to the client.
        const retry = existing?.phase === "failed" && existing.error?.retryable === true;
        if (existing?.phase === "failed" && !(retry && request !== null)) {
          return yield* errorOf(existing.error ?? failureOf(interruptedRunError()));
        }
        return yield* permits.withPermits(1)(
          Effect.gen(function* () {
            let row = existing;
            if (row === undefined) {
              if (request === null || digest === null) return yield* interruptedRunError();
              row = yield* accept(request, digest);
              yield* runPoint("accepted", row);
            } else if (row.phase === "failed") {
              // Fenced on the failure as read: an expiry that settled it meanwhile wins.
              row = yield* advance(row, "accepted", { checkout: null, error: null }, false, true);
            } else if (request === null && givesUp(row)) {
              return yield* settleStalled(row);
            }
            return yield* drive(row);
          }),
        );
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          const failure = Cause.squash(cause);
          if (isForkRunError(failure)) return Effect.fail(failure);
          return Effect.logWarning("thread fork run stopped", {
            forkKey,
            cause: Cause.pretty(cause),
          }).pipe(Effect.andThen(Effect.fail(interruptedRunError())));
        }),
      );

    /**
     * The node drives a key again itself when an attempt left its row unfinished (its error says
     * `running`): after a wait that grows with every stop, so `running` always means the node
     * finishes the fork or settles it, not only on a retry or a restart. Every stop counts toward
     * `givesUp`, which turns the next run into a settle. Any other outcome clears the key; an
     * interrupted attempt (shutdown) leaves it to startup recovery.
     */
    const scheduleRedrive = (
      forkKey: string,
      exit: Exit.Exit<ThreadForkResult, ThreadForkError>,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
        const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
        if (!(Schema.is(ThreadForkError)(failure) && failure.attempt === "running")) {
          redrives.delete(forkKey);
          reservedWorktreePaths.delete(forkKey);
          return Effect.void;
        }
        const entry = redrives.get(forkKey) ?? { stops: 0, scheduled: false };
        entry.stops += 1;
        redrives.set(forkKey, entry);
        if (entry.scheduled) return Effect.void;
        entry.scheduled = true;
        const wait = redriveBackoff[Math.min(entry.stops, redriveBackoff.length) - 1]!;
        return Effect.sleep(wait).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              // Settled (or rescheduled after settling) meanwhile: nothing to do.
              if (redrives.get(forkKey) !== entry) return Effect.void;
              entry.scheduled = false;
              // An attempt running now schedules the next drive itself if it stops again.
              if (flights.has(forkKey)) return Effect.void;
              return driveUnattended(forkKey, "thread fork re-drive did not finish");
            }),
          ),
          Effect.forkIn(serviceScope),
          Effect.asVoid,
        );
      });

    /**
     * Joins the running attempt for a key, or starts one detached from the caller, so a
     * disconnect cannot cut a fork off halfway.
     */
    const join = (
      forkKey: string,
      request: ThreadForkInput | null,
      digest: string | null,
    ): Effect.Effect<ThreadForkResult, ThreadForkError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const running = flights.get(forkKey);
          if (running !== undefined) {
            if (digest !== null && running.digest === null) {
              // The node is resuming this key itself: wait for it, then answer this request
              // against the row it left (its digest decides replay or conflict).
              return restore(
                Deferred.await(running.outcome).pipe(
                  Effect.ignore,
                  Effect.andThen(join(forkKey, request, digest)),
                ),
              );
            }
            if (digest !== null && running.digest !== digest) {
              // An attempt for the key is in progress right now.
              return Effect.fail(
                new ThreadForkError({
                  reason: "idempotency-conflict",
                  message: CONFLICT_MESSAGE,
                  retryable: false,
                  attempt: "running",
                }),
              );
            }
            return restore(Deferred.await(running.outcome));
          }
          const outcome = Deferred.makeUnsafe<ThreadForkResult, ThreadForkError>();
          flights.set(forkKey, { digest, outcome });
          return attempt(forkKey, request, digest).pipe(
            Effect.catch((error) => reportError(forkKey, error).pipe(Effect.flatMap(Effect.fail))),
            Effect.onExit((exit) =>
              Effect.suspend(() => {
                if (flights.get(forkKey)?.outcome === outcome) flights.delete(forkKey);
                return Deferred.done(outcome, exit).pipe(
                  Effect.andThen(scheduleRedrive(forkKey, exit)),
                );
              }),
            ),
            Effect.forkIn(serviceScope),
            Effect.andThen(restore(Deferred.await(outcome))),
          );
        }),
      );

    /** Drives a key without a request (recovery, re-drive); the outcome is only logged. */
    const driveUnattended = (forkKey: string, unfinished: string) =>
      join(forkKey, null, null).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(unfinished, {
            forkKey,
            reason: error.reason,
            detail: error.message,
          }),
        ),
        Effect.ignore,
      );

    const fork: ThreadForkShape["fork"] = (input) =>
      join(input.forkKey, input, threadForkRequestDigest(input));

    const attemptState: ThreadForkShape["attemptState"] = (forkKey) =>
      flights.has(forkKey) ? Effect.succeed("running") : recordedAttempt(forkKey);

    /**
     * Retryable failures nobody retried within the retry window: release their pinned commits and
     * settle them, so they stop holding refs and history forever.
     */
    const expireAbandonedRetries = Effect.gen(function* () {
      const rows = yield* ledger.listRetryableFailed({
        updatedBefore: new Date(now().getTime() - THREAD_FORK_RETRY_WINDOW_MS).toISOString(),
      });
      for (const row of rows) {
        if (flights.has(row.forkKey)) continue;
        yield* expireRetry(row);
      }
    });

    /**
     * One recovery sweep: expires abandoned retries, then drives every unfinished fork that no
     * attempt is running for and no re-drive is already scheduled for (that one keeps its
     * backoff). At startup that is every unfinished fork an earlier process left.
     */
    const recover: ThreadForkShape["recover"] = () =>
      Effect.gen(function* () {
        yield* expireAbandonedRetries.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("thread fork retry expiry failed", {
                  cause: Cause.pretty(cause),
                }),
          ),
        );
        // Keys only: each fork's attempt reads its full row once it runs.
        const unfinished = yield* ledger.listUnfinishedKeys();
        yield* Effect.forEach(
          unfinished.filter(
            ({ forkKey }) => !flights.has(forkKey) && redrives.get(forkKey)?.scheduled !== true,
          ),
          ({ forkKey }) => driveUnattended(forkKey, "thread fork recovery did not finish"),
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("thread fork recovery failed", { cause: Cause.pretty(cause) }),
        ),
      );

    return { fork, attemptState, recover } satisfies ThreadForkShape;
  });

/**
 * Once the server admits commands (after startup recovery), resumes the forks an earlier process
 * left unfinished, then sweeps again periodically: a node that keeps running still expires
 * abandoned retries and drives any unfinished fork nothing else drives.
 */
export const makeThreadForkLive = (options: ThreadForkTestOptions = {}) =>
  Layer.effect(
    ThreadFork,
    Effect.gen(function* () {
      const service = yield* makeThreadFork(options);
      const startup = yield* Effect.serviceOption(ServerRuntimeStartup);
      if (Option.isSome(startup)) {
        yield* Effect.forkScoped(
          startup.value.awaitCommandReady.pipe(
            Effect.andThen(
              service
                .recover()
                .pipe(
                  Effect.repeat(
                    Schedule.spaced(
                      options.recoverySweepInterval ?? THREAD_FORK_RECOVERY_SWEEP_INTERVAL,
                    ),
                  ),
                ),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("thread fork recovery did not start", {
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
        );
      }
      return service;
    }),
  );

export const ThreadForkLive = makeThreadForkLive();
