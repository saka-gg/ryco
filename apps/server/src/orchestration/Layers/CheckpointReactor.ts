import {
  CommandId,
  EventId,
  MessageId,
  type CheckpointRef,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";
import { Cause, Deferred, Effect, Layer, Option, Stream } from "effect";
import { makeKeyedSerialWorker } from "@ryco/shared/KeyedSerialWorker";
import { losslessBackpressureQueuePolicy } from "@ryco/shared/QueuePolicy";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { isInheritedItemId } from "../forkInheritance.ts";
import { selectTurnReplyMessage } from "@ryco/shared/turnReply";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { findThreadSession } from "../../provider/threadSessionLookup.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { CheckpointInvariantError, type CheckpointStoreError } from "../../checkpointing/Errors.ts";
import { makeCheckpointRevertActivity } from "../checkpointRevertPolicy.ts";
import type { CheckpointRevertSaga } from "../checkpointRevertSaga.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { LocalDiagnosticsMetrics } from "../../observability/Services/LocalDiagnosticsMetrics.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { WorkspaceEntries } from "../../workspace/Services/WorkspaceEntries.ts";

/** The domain events this reactor handles; all of them name their thread. */
type CheckpointDomainEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.turn-start-requested"
      | "thread.message-sent"
      | "thread.checkpoint-revert-requested"
      | "thread.turn-diff-completed";
  }
>;

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: CheckpointDomainEvent;
    }
  | {
      /** A turn start waiting for its pre-turn baseline (see `ensurePreTurnBaseline`). */
      readonly source: "baseline";
      readonly threadId: ThreadId;
      readonly done: Deferred.Deferred<void>;
    };

const inputThreadId = (input: ReactorInput): ThreadId =>
  input.source === "baseline"
    ? input.threadId
    : input.source === "runtime"
      ? input.event.threadId
      : input.event.payload.threadId;

/** A user message that starts a turn, not an assistant reply or a streaming delta. */
const isTurnStartingUserMessage = (event: CheckpointDomainEvent): boolean =>
  event.type !== "thread.message-sent" ||
  (event.payload.role === "user" &&
    !event.payload.streaming &&
    event.payload.turnId === null &&
    // Published history, not a send: a fork's inherited messages start no turn.
    !isInheritedItemId(event.payload.threadId, event.payload.messageId));

/** Messages read to pick a turn's reply; far more than any turn's attachment carriers. */
const TURN_REPLY_CANDIDATE_LIMIT = 200;
/** Threads whose newest known checkpoint ref is remembered. */
const KNOWN_CHECKPOINT_REFS_MAX = 2_048;

const latestCheckpointTurnCount = (
  checkpoints: ReadonlyArray<{ readonly checkpointTurnCount: number }>,
): number =>
  checkpoints.reduce(
    (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
    0,
  );

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

export interface CheckpointReactorOptions {
  /** Loads the revert saga's module; tests make it fail. Defaults to `import()`. */
  readonly loadRevertSagaModule?: () => Promise<typeof import("../checkpointRevertSaga.ts")>;
}

const make = Effect.fn("makeCheckpointReactor")(function* (options: CheckpointReactorOptions) {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const localDiagnosticsMetrics = yield* LocalDiagnosticsMetrics;
  const workspaceEntries = yield* WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-capture-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.capture.failed",
        summary: "Checkpoint capture failed",
        payload: {
          detail: input.detail,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const session = yield* findThreadSession(providerService, threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  // Full thread detail: reverts only. Turn starts and completions read the
  // narrow checkpoint context instead of every message and activity.
  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /** The thread's checkout and projected checkpoints, without messages or activities. */
  const resolveCheckpointContext = Effect.fn("resolveCheckpointContext")(function* (
    threadId: ThreadId,
  ) {
    return yield* projectionSnapshotQuery
      .getThreadCheckpointContext(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /** The reply a turn's checkpoint is keyed on, from that turn's newest messages only. */
  const resolveTurnReplyMessageId = Effect.fn("resolveTurnReplyMessageId")(function* (
    threadId: ThreadId,
    turnId: TurnId,
  ) {
    const listByTurn = projectionSnapshotQuery.listThreadMessagesByTurn;
    const messages = listByTurn
      ? (yield* listByTurn({ threadId, turnId, limit: TURN_REPLY_CANDIDATE_LIMIT })).toReversed()
      : ((yield* resolveThreadDetail(threadId))?.messages ?? []);
    return selectTurnReplyMessage(messages, turnId)?.id;
  });

  /**
   * The newest checkpoint ref known to exist per thread: a baseline this
   * reactor ensured, or a completion it captured (turn N's capture is turn
   * N+1's baseline). The repeated turn-start triggers then skip the ref probe.
   * A revert deletes refs, so it forgets its thread.
   */
  const knownCheckpointRefs = new Map<ThreadId, string>();
  const checkpointRefKey = (cwd: string, checkpointRef: CheckpointRef) =>
    `${cwd}\0${checkpointRef}`;
  const rememberCheckpointRef = (threadId: ThreadId, cwd: string, checkpointRef: CheckpointRef) =>
    Effect.sync(() => {
      knownCheckpointRefs.delete(threadId);
      knownCheckpointRefs.set(threadId, checkpointRefKey(cwd, checkpointRef));
      for (const oldest of knownCheckpointRefs.keys()) {
        if (knownCheckpointRefs.size <= KNOWN_CHECKPOINT_REFS_MAX) break;
        knownCheckpointRefs.delete(oldest);
      }
    });
  const forgetCheckpointRefs = (threadId: ThreadId) =>
    Effect.sync(() => {
      knownCheckpointRefs.delete(threadId);
    });

  const isGitWorkspace = (cwd: string) => isGitRepository(cwd);

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined> {
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });
    // The thread's own workspace answers a baseline without a session lookup.
    const fromSession =
      input.preferSessionRuntime || fromThread === undefined
        ? yield* resolveSessionRuntimeForThread(input.threadId)
        : Option.none<{ readonly threadId: ThreadId; readonly cwd: string }>();

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!isGitWorkspace(cwd)) {
      return undefined;
    }
    return cwd;
  });

  const resolveCheckpointCwdFromContext = (
    context: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly worktreePath: string | null;
    },
    preferSessionRuntime: boolean,
  ) =>
    resolveCheckpointCwd({
      threadId: context.threadId,
      thread: context,
      projects: [{ id: context.projectId, workspaceRoot: context.workspaceRoot }],
      preferSessionRuntime,
    });

  // The revert saga loads on the first revert, or the first pending one at startup:
  // a boot without either never evaluates it. Only a loaded saga is kept, so a failed
  // load is tried again by the next revert.
  const loadRevertSagaModule =
    options.loadRevertSagaModule ?? (() => import("../checkpointRevertSaga.ts"));
  let revertSaga: CheckpointRevertSaga | undefined;
  const loadRevertSaga = Effect.suspend(() =>
    revertSaga !== undefined
      ? Effect.succeed(revertSaga)
      : Effect.tryPromise({
          try: loadRevertSagaModule,
          catch: (cause) =>
            new CheckpointInvariantError({
              operation: "CheckpointReactor.loadRevertSaga",
              detail: "Failed to load the checkpoint revert saga.",
              cause,
            }),
        }).pipe(
          Effect.map((module) => {
            revertSaga ??= module.makeCheckpointRevertSaga({
              orchestrationEngine,
              projectionSnapshotQuery,
              providerService,
              checkpointStore,
              workspaceEntries,
              vcsStatusBroadcaster,
              forgetCheckpointRefs,
              resolveCheckpointCwd,
            });
            return revertSaga;
          }),
        ),
  );

  // Without the saga, a requested revert still ends: nothing was changed.
  const failUnloadedRevert = (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
    error: CheckpointInvariantError,
  ) => {
    const createdAt = new Date().toISOString();
    return Effect.logError("failed to load the checkpoint revert saga", {
      threadId: event.payload.threadId,
      cause: Cause.pretty(Cause.fail(error)),
    }).pipe(
      Effect.andThen(
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: serverCommandId("checkpoint-revert"),
          threadId: event.payload.threadId,
          activity: makeCheckpointRevertActivity({
            revertRequestId: event.commandId ?? serverCommandId("checkpoint-revert-request"),
            turnCount: event.payload.turnCount,
            status: "failed",
            reason: "internal-error",
            detail: "Ryco could not start the revert. Nothing was changed. Try again.",
            ...(event.payload.restoreFiles === false ? { restoreFiles: false as const } : {}),
            ...(event.payload.rollbackConversation === false
              ? { rollbackConversation: false as const }
              : {}),
            createdAt,
          }),
          createdAt,
        }),
      ),
      Effect.asVoid,
    );
  };

  // Shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
    readonly quiescenceStartedAt?: number;
  }) {
    const checkpointStartedAt = Date.now();
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });
    yield* rememberCheckpointRef(input.threadId, input.cwd, targetCheckpointRef);

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.invalidate(input.cwd);

    const files = yield* checkpointStore
      .diffCheckpoints({
        cwd: input.cwd,
        fromCheckpointRef,
        toCheckpointRef: targetCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      })
      .pipe(
        Effect.map((diff) =>
          parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
            path: file.path,
            kind: file.kind,
            additions: file.additions,
            deletions: file.deletions,
          })),
        ),
        Effect.tapError((error) =>
          appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
            createdAt: input.createdAt,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to derive checkpoint file summary", {
            threadId: input.threadId,
            turnId: input.turnId,
            turnCount: input.turnCount,
            detail: error.message,
          }).pipe(Effect.as([])),
        ),
      );

    // Keyed on the turn's reply, not on a page or file it published after the reply.
    const assistantMessageId =
      input.assistantMessageId ??
      (yield* resolveTurnReplyMessageId(input.threadId, input.turnId)) ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* localDiagnosticsMetrics.recordCheckpointDurationMs(Date.now() - checkpointStartedAt);
    if (input.quiescenceStartedAt !== undefined) {
      yield* localDiagnosticsMetrics.recordTurnQuiescenceMs(Date.now() - input.quiescenceStartedAt);
    }
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Captures a real git checkpoint when a turn completes via a runtime event.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (
      event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
      quiescenceStartedAt: number,
    ) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const shell = Option.getOrUndefined(
        yield* projectionSnapshotQuery.getThreadShellById(event.threadId),
      );
      const context = shell ? yield* resolveCheckpointContext(event.threadId) : undefined;
      if (!shell || !context) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (shell.session?.activeTurnId && !sameId(shell.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        context.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const checkpointCwd = yield* resolveCheckpointCwdFromContext(context, true);
      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = context.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : latestCheckpointTurnCount(context.checkpoints) + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: context.threadId,
        turnId,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status: checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: undefined,
        createdAt: event.createdAt,
        quiescenceStartedAt,
      });
    },
  );

  // Captures a real git checkpoint when a placeholder checkpoint (status "missing")
  // is detected via a domain event. This replaces the placeholder with a real
  // git-ref-based checkpoint.
  //
  // ProviderRuntimeIngestion creates placeholder checkpoints on turn.diff.updated
  // events from the Codex runtime. This handler fires when the corresponding
  // domain event arrives, allowing the reactor to capture the actual filesystem
  // state into a git ref and dispatch a replacement checkpoint.
  const captureCheckpointFromPlaceholder = Effect.fn("captureCheckpointFromPlaceholder")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) {
    const { threadId, turnId, checkpointTurnCount, status } = event.payload;

    // Only replace placeholders; skip events from our own real captures.
    if (status !== "missing") {
      return;
    }

    const context = yield* resolveCheckpointContext(threadId);
    if (!context) {
      yield* Effect.logWarning("checkpoint capture from placeholder skipped: thread not found", {
        threadId,
      });
      return;
    }

    // If a real checkpoint already exists for this turn, skip.
    if (
      context.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      yield* Effect.logDebug(
        "checkpoint capture from placeholder skipped: real checkpoint already exists",
        { threadId, turnId },
      );
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwdFromContext(context, true);
    if (!checkpointCwd) {
      return;
    }

    yield* captureAndDispatchCheckpoint({
      threadId,
      turnId,
      cwd: checkpointCwd,
      turnCount: checkpointTurnCount,
      status: "ready",
      assistantMessageId: event.payload.assistantMessageId ?? undefined,
      createdAt: event.payload.completedAt,
    });
  });

  /**
   * Makes sure the ref of the thread's newest projected checkpoint exists, so
   * the next turn's diff and revert have a baseline. Every turn-start trigger
   * runs this; after the first, the known-ref memo answers without git.
   */
  const ensurePreTurnBaseline = Effect.fn("ensurePreTurnBaseline")(function* (
    threadId: ThreadId,
    createdAt: string,
  ) {
    const context = yield* resolveCheckpointContext(threadId);
    if (!context) {
      return;
    }
    const checkpointCwd = yield* resolveCheckpointCwdFromContext(context, false);
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = latestCheckpointTurnCount(context.checkpoints);
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    if (
      knownCheckpointRefs.get(threadId) === checkpointRefKey(checkpointCwd, baselineCheckpointRef)
    ) {
      return;
    }
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (!baselineExists) {
      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt,
      });
    }
    yield* rememberCheckpointRef(threadId, checkpointCwd, baselineCheckpointRef);
  });

  // Turns the provider started on its own reach no domain turn-start trigger.
  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      if (!toTurnId(event.turnId)) {
        return;
      }
      yield* ensurePreTurnBaseline(event.threadId, event.createdAt);
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }),
      ),
    );
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (!isTurnStartingUserMessage(event)) {
      return;
    }
    yield* ensurePreTurnBaseline(event.payload.threadId, event.occurredAt);
  });

  const recover: CheckpointReactorShape["recover"] = () =>
    Effect.gen(function* () {
      const listPending = projectionSnapshotQuery.listPendingCheckpointReverts;
      if (!listPending) return;
      const pending = yield* listPending();
      if (pending.length === 0) return;
      // Each entry is isolated: one thread's failure never skips the others.
      yield* (yield* loadRevertSaga).recover(pending);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError("checkpoint revert recovery failed", { cause: Cause.pretty(cause) }),
      ),
    );

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: CheckpointDomainEvent,
  ) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      const saga = yield* Effect.result(loadRevertSaga);
      if (saga._tag === "Failure") {
        yield* failUnloadedRevert(event, saga.failure);
        return;
      }
      yield* saga.success.handleRevertRequested(event);
      return;
    }

    // When ProviderRuntimeIngestion creates a placeholder checkpoint (status "missing")
    // from a turn.diff.updated runtime event, capture the real git checkpoint to
    // replace it. The providerService.streamEvents PubSub does not reliably deliver
    // turn.completed runtime events to this reactor (shared subscription), so
    // reacting to the domain event is the reliable path.
    if (event.type === "thread.turn-diff-completed") {
      yield* captureCheckpointFromPlaceholder(event).pipe(
        Effect.catch((error) =>
          appendCaptureFailureActivity({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "turn.started") {
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      const quiescenceStartedAt = Date.now();
      yield* refreshLocalGitStatusFromTurnCompletion(event);
      yield* captureCheckpointFromTurnCompletion(event, quiescenceStartedAt).pipe(
        Effect.catch((error) =>
          appendCaptureFailureActivity({
            threadId: event.threadId,
            turnId,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<void, CheckpointStoreError | OrchestrationDispatchError, never> =>
    input.source === "baseline"
      ? ensurePreTurnBaseline(input.threadId, new Date().toISOString())
      : input.source === "domain"
        ? processDomainEvent(input.event)
        : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          ...(input.source === "baseline"
            ? { threadId: input.threadId }
            : { eventType: input.event.type }),
          cause: Cause.pretty(cause),
        });
      }),
      Effect.ensuring(
        input.source === "baseline" ? Deferred.succeed(input.done, undefined) : Effect.void,
      ),
    );

  // One lane per thread: a thread's checkpoint work stays in order (turn N's
  // completion capture before turn N+1's baseline), and one thread's slow git
  // work never delays another thread's.
  const worker = yield* makeKeyedSerialWorker({
    policy: losslessBackpressureQueuePolicy({
      component: "CheckpointReactor",
      capacity: 1_024,
    }),
    process: (_threadId: ThreadId, input: ReactorInput) => processInputSafely(input),
  });
  const enqueue = (input: ReactorInput) => worker.enqueue(inputThreadId(input), input);

  const ensurePreTurnBaselineForTurnStart: CheckpointReactorShape["ensurePreTurnBaseline"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      yield* enqueue({ source: "baseline", threadId, done });
      yield* Deferred.await(done);
    });

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested" &&
          event.type !== "thread.turn-diff-completed"
        ) {
          return Effect.void;
        }
        // Assistant replies and streaming deltas never start a turn: keep them
        // out of the lanes.
        if (!isTurnStartingUserMessage(event)) {
          return Effect.void;
        }
        return enqueue({ source: "domain", event });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.started" && event.type !== "turn.completed") {
          return Effect.void;
        }
        return enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    recover,
    ensurePreTurnBaseline: ensurePreTurnBaselineForTurnStart,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const makeCheckpointReactorLive = (options: CheckpointReactorOptions = {}) =>
  Layer.effect(CheckpointReactor, make(options));

export const CheckpointReactorLive = makeCheckpointReactorLive();
