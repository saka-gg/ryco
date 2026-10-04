import {
  CommandId,
  ContextHandoffActivityPayload,
  EventId,
  MessageId,
  type CheckpointRef,
  type CheckpointRevertActivityPayload,
  type CheckpointRevertFailureReason,
  type CheckpointRevertStatus,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";
import { Cause, Effect, Layer, Option, Schema, Stream } from "effect";
import { makeDrainableWorker } from "@ryco/shared/DrainableWorker";
import { losslessBackpressureQueuePolicy } from "@ryco/shared/QueuePolicy";
import { getThreadLastActivityTimestamp } from "@ryco/shared/threadSettlement";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRestoreConflictMessage,
  checkpointRestoreConflictReason,
  evaluateCheckpointRestoreSafety,
  type CheckoutPathOps,
  type CheckpointRestoreSafety,
  type RestoreNeighbour,
  type RestoreSource,
} from "../../checkpointing/restoreSafety.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import {
  canonicalizeFilesystemPath,
  isCaseSensitiveFileSystem,
} from "../../git/worktreeReconciliation.ts";
import {
  CHECKPOINT_REVERT_PENDING_STALE_MS,
  makeCheckpointRevertActivity,
  threadBusyMessage,
  threadBusyReason,
} from "../checkpointRevertPolicy.ts";
import { latestTurnFromCheckpoint } from "../projector.ts";
import { threadShellSettlementInput } from "../threadSettlementInput.ts";
import { userFacingFailureDetail } from "../userFacingErrors.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { LocalDiagnosticsMetrics } from "../../observability/Services/LocalDiagnosticsMetrics.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { WorkspaceEntries } from "../../workspace/Services/WorkspaceEntries.ts";

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

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

export function providerRollbackEpochViolation(
  thread: OrchestrationThread,
  targetTurnCount: number,
): string | null {
  const currentTurnCount = thread.checkpoints.reduce(
    (maximum, checkpoint) => Math.max(maximum, checkpoint.checkpointTurnCount),
    0,
  );
  if (targetTurnCount >= currentTurnCount) {
    return null;
  }

  const decodeHandoff = Schema.decodeUnknownOption(ContextHandoffActivityPayload);
  const latestConsumedHandoff = thread.activities
    .flatMap((activity) => {
      if (activity.kind !== "context-handoff") return [];
      return Option.match(decodeHandoff(activity.payload), {
        onNone: () => [],
        onSome: (payload) => (payload.status === "consumed" ? [{ activity, payload }] : []),
      });
    })
    .toSorted(
      (left, right) =>
        (left.activity.sequence ?? 0) - (right.activity.sequence ?? 0) ||
        left.activity.createdAt.localeCompare(right.activity.createdAt) ||
        left.activity.id.localeCompare(right.activity.id),
    )
    .at(-1);
  if (!latestConsumedHandoff) {
    return null;
  }

  const activeRuntimeSessionId = thread.session?.runtimeSessionId;
  const targetRuntimeSessionId = latestConsumedHandoff.payload.targetRuntimeSessionId;
  if (
    activeRuntimeSessionId === undefined ||
    targetRuntimeSessionId === undefined ||
    activeRuntimeSessionId !== targetRuntimeSessionId
  ) {
    return "Provider conversation rollback was not applied because the active runtime epoch could not be verified after a context handoff. Nothing was changed.";
  }

  const targetMessage = thread.messages.find(
    (message) => message.id === latestConsumedHandoff.payload.targetMessageId,
  );
  const firstEpochCheckpoint =
    (latestConsumedHandoff.payload.targetTurnId !== undefined
      ? thread.checkpoints.find(
          (checkpoint) => checkpoint.turnId === latestConsumedHandoff.payload.targetTurnId,
        )
      : undefined) ??
    (targetMessage
      ? thread.checkpoints
          .filter((checkpoint) => checkpoint.completedAt >= targetMessage.createdAt)
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)[0]
      : undefined);
  if (!firstEpochCheckpoint) {
    return "Provider conversation rollback was not applied because the active handoff boundary could not be mapped to a checkpoint. Nothing was changed.";
  }

  // The handoff transcript is the provider input of the first epoch turn, so the
  // epoch baseline (one before it) would drop the whole handed-off context.
  const epochBaselineTurnCount = Math.max(0, firstEpochCheckpoint.checkpointTurnCount - 1);
  return targetTurnCount <= epochBaselineTurnCount
    ? `Reverting to checkpoint ${targetTurnCount} would discard the turn that carried the context handoff (checkpoint ${firstEpochCheckpoint.checkpointTurnCount}). Revert to checkpoint ${firstEpochCheckpoint.checkpointTurnCount} or later. Nothing was changed.`
    : null;
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

/** How far a live revert got, so an unexpected failure is journaled honestly. */
type RevertProgress = { phase: "validating" | "rolling-back" | "restoring-files" };

type PendingCheckpointRevert = {
  readonly threadId: ThreadId;
  readonly activity: OrchestrationThreadActivity;
  readonly payload: CheckpointRevertActivityPayload;
};

function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Ends a refusal with "Nothing was changed." unless it already says so, in any case. */
function withNothingChanged(detail: string): string {
  return /\bnothing was changed\b/i.test(detail)
    ? detail.trim()
    : `${asSentence(detail)} Nothing was changed.`;
}

/** Whether the thread gained messages, turns, or checkpoints after `sinceIso`. */
function threadChangedSince(thread: OrchestrationThread, sinceIso: string): boolean {
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return true;
  const after = (value: string | null | undefined) =>
    value !== null && value !== undefined && Date.parse(value) > sinceMs;
  return (
    thread.messages.some((message) => after(message.createdAt)) ||
    thread.checkpoints.some((checkpoint) => after(checkpoint.completedAt)) ||
    after(thread.latestTurn?.requestedAt) ||
    after(thread.latestTurn?.startedAt)
  );
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const localDiagnosticsMetrics = yield* LocalDiagnosticsMetrics;
  const workspaceEntries = yield* WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;

  type RevertPhaseInput = {
    readonly threadId: ThreadId;
    readonly revertRequestId: CommandId;
    readonly turnCount: number;
    readonly fromTurnCount?: number | undefined;
    readonly status: CheckpointRevertStatus;
    readonly reason?: CheckpointRevertFailureReason | undefined;
    readonly detail?: string | undefined;
    readonly cwd?: string | undefined;
  };

  /** Journals one revert phase; fails when the phase could not be recorded. */
  const recordRevertPhase = (input: RevertPhaseInput) => {
    const createdAt = new Date().toISOString();
    return orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("checkpoint-revert"),
        threadId: input.threadId,
        activity: makeCheckpointRevertActivity({ ...input, createdAt }),
        createdAt,
      })
      .pipe(Effect.asVoid);
  };

  /** Best-effort journal update: a lost update is logged, never fatal. */
  const updateRevert = (input: RevertPhaseInput) =>
    recordRevertPhase(input).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to record checkpoint revert phase", {
          threadId: input.threadId,
          revertRequestId: input.revertRequestId,
          status: input.status,
          detail: error.message,
        }),
      ),
    );

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
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
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
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

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

  // Shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
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

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
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

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
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

    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      yield* Effect.logWarning("checkpoint capture from placeholder skipped: thread not found", {
        threadId,
      });
      return;
    }

    // If a real checkpoint already exists for this turn, skip.
    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      yield* Effect.logDebug(
        "checkpoint capture from placeholder skipped: real checkpoint already exists",
        { threadId, turnId },
      );
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
      return;
    }

    yield* captureAndDispatchCheckpoint({
      threadId,
      turnId,
      thread,
      cwd: checkpointCwd,
      turnCount: checkpointTurnCount,
      status: "ready",
      assistantMessageId: event.payload.assistantMessageId ?? undefined,
      createdAt: event.payload.completedAt,
    });
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: false,
      });
      if (!checkpointCwd) {
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      if (baselineExists) {
        return;
      }

      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: event.createdAt,
      });
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
    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  const sameCheckoutOps = (): CheckoutPathOps => {
    // Canonicalize and probe each path once per evaluation.
    const canonical = new Map<string, string>();
    const gitEntries = new Map<string, boolean>();
    return {
      canonicalize: (value) => {
        const cached = canonical.get(value);
        if (cached !== undefined) return cached;
        const resolved = canonicalizeFilesystemPath(value);
        canonical.set(value, resolved);
        return resolved;
      },
      caseSensitive: isCaseSensitiveFileSystem(),
      hasGitEntry: (dir) => {
        const cached = gitEntries.get(dir);
        if (cached !== undefined) return cached;
        const exists = isGitRepository(dir);
        gitEntries.set(dir, exists);
        return exists;
      },
    };
  };

  // Every other live thread, with the paths it works in: its workspace and
  // its live provider session cwd.
  const buildRestoreNeighbours = Effect.fn("buildRestoreNeighbours")(function* (
    threadId: ThreadId,
  ) {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const sessions = yield* providerService.listSessions();
    const nowIso = new Date().toISOString();
    const sessionCwdsByThread = new Map<string, Array<string>>();
    for (const session of sessions) {
      if (session.status === "closed" || !session.cwd) continue;
      const cwds = sessionCwdsByThread.get(session.threadId) ?? [];
      cwds.push(session.cwd);
      sessionCwdsByThread.set(session.threadId, cwds);
    }
    return snapshot.threads
      .filter((thread) => thread.id !== threadId)
      .map((thread): RestoreNeighbour => {
        const workspace = resolveThreadWorkspaceCwd({ thread, projects: snapshot.projects });
        const paths = new Set<string>([
          ...(workspace ? [workspace] : []),
          ...(sessionCwdsByThread.get(thread.id) ?? []),
        ]);
        const input = threadShellSettlementInput(thread, nowIso);
        return {
          threadId: thread.id,
          title: thread.title,
          paths: Array.from(paths),
          busy: threadBusyReason(input) !== null || thread.backgroundLiveness === "working",
          lastActivityAt: getThreadLastActivityTimestamp(input),
        };
      });
  });

  const evaluateRestoreSafety = Effect.fn("evaluateRestoreSafety")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly turnCount: number;
    readonly cwd: string;
    readonly source: RestoreSource;
  }): Effect.fn.Return<CheckpointRestoreSafety, never> {
    const neighbours = yield* buildRestoreNeighbours(input.thread.id).pipe(
      Effect.catch((error) =>
        // Without the neighbour set the restore cannot be proven safe.
        Effect.logWarning("failed to list checkpoint restore neighbours", {
          threadId: input.thread.id,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (neighbours === null) {
      return { kind: "conflict", reason: "neighbour-busy", threads: [] } as const;
    }
    const target =
      input.turnCount === 0
        ? undefined
        : input.thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === input.turnCount,
          );
    // Both instants are conservative: the real capture happened at or after them.
    const targetInstantMs = Date.parse(target?.completedAt ?? input.thread.createdAt);
    return evaluateCheckpointRestoreSafety({
      checkoutRoot: input.cwd,
      source: input.source,
      targetInstantMs,
      neighbours,
      ops: sameCheckoutOps(),
    });
  });

  const restoreConflictText = (result: CheckpointRestoreSafety, turnCount: number) =>
    result.kind === "safe"
      ? null
      : result.threads.length === 0 && result.reason === "neighbour-busy"
        ? "Ryco could not check which other threads use this checkout."
        : checkpointRestoreConflictReason(result, turnCount);

  /** Where checkpoint K's files come from, or null when they are unavailable. */
  const resolveRestorePlan = Effect.fn("resolveRestorePlan")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly turnCount: number;
    readonly cwd: string;
  }) {
    const targetRef: CheckpointRef | undefined =
      input.turnCount === 0
        ? checkpointRefForThreadTurn(input.thread.id, 0)
        : input.thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === input.turnCount,
          )?.checkpointRef;
    if (!targetRef) return null;
    if (yield* checkpointStore.hasCheckpointRef({ cwd: input.cwd, checkpointRef: targetRef })) {
      return { targetRef, source: "ref" as RestoreSource };
    }
    if (input.turnCount === 0 && (yield* checkpointStore.hasHeadCommit(input.cwd))) {
      return { targetRef, source: "head-fallback" as RestoreSource };
    }
    return null;
  });

  const revertOutcome = (thread: OrchestrationThread, turnCount: number) => {
    const ordered = thread.checkpoints.toSorted(
      (left, right) => left.checkpointTurnCount - right.checkpointTurnCount,
    );
    const target = ordered.find((checkpoint) => checkpoint.checkpointTurnCount === turnCount);
    return {
      currentTurnCount: ordered.at(-1)?.checkpointTurnCount ?? 0,
      dropped: ordered.filter((checkpoint) => checkpoint.checkpointTurnCount > turnCount),
      targetTurnId: turnCount === 0 ? null : (target?.turnId ?? null),
      latestTurn: turnCount === 0 || !target ? null : latestTurnFromCheckpoint(target),
    };
  };

  // Shared by the live path and startup recovery: the provider conversation
  // already matches checkpoint K (or nothing was dropped), so project the
  // revert and restore files when that is still safe.
  const finishRevert = Effect.fn("finishRevert")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly revertRequestId: CommandId;
    readonly turnCount: number;
    readonly cwd: string;
  }) {
    const { thread, revertRequestId, turnCount, cwd } = input;
    const threadId = thread.id;
    const outcome = revertOutcome(thread, turnCount);
    const unavailableText = `the files for checkpoint ${turnCount} are no longer available`;

    type FilesNotRestored = {
      readonly reason: CheckpointRevertFailureReason;
      readonly text: string;
    };
    const restoreFiles = Effect.fn("restoreRevertFiles")(function* (): Effect.fn.Return<
      FilesNotRestored | null,
      CheckpointStoreError
    > {
      const plan = yield* resolveRestorePlan({ thread, turnCount, cwd });
      if (plan === null) return { reason: "files-failed", text: unavailableText };
      const safety = yield* evaluateRestoreSafety({
        thread,
        turnCount,
        cwd,
        source: plan.source,
      });
      const conflictText = restoreConflictText(safety, turnCount);
      if (conflictText !== null) return { reason: "shared-checkout", text: conflictText };
      const restored = yield* checkpointStore.restoreCheckpoint({
        cwd,
        checkpointRef: plan.targetRef,
        fallbackToHead: plan.source === "head-fallback",
      });
      if (!restored) return { reason: "files-failed", text: unavailableText };
      // Keep the @-mention file picker in step with the reverted files.
      yield* workspaceEntries.invalidate(cwd);
      return null;
    });
    // The provider may already have forgotten the dropped turns, so nothing
    // here may skip projecting the revert: any file failure is reported.
    const filesNotRestoredReason = yield* restoreFiles().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("failed to restore checkpoint files after revert", {
              threadId,
              turnCount,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.as<FilesNotRestored>({
                reason: "files-failed",
                text: userFacingFailureDetail(cause),
              }),
            ),
      ),
    );

    const fromTurnCount = outcome.currentTurnCount;
    if (outcome.dropped.length === 0 && filesNotRestoredReason !== null) {
      // Nothing was dropped, so there is nothing to project: report honestly.
      yield* updateRevert({
        threadId,
        revertRequestId,
        turnCount,
        fromTurnCount,
        status: "failed",
        reason: filesNotRestoredReason.reason,
        detail: `Files were not restored: ${filesNotRestoredReason.text.replace(/[.\s]+$/, "")}. Nothing was changed.`,
        cwd,
      });
      return;
    }

    if (outcome.dropped.length > 0) {
      yield* checkpointStore
        .deleteCheckpointRefs({
          cwd,
          checkpointRefs: outcome.dropped.map((checkpoint) => checkpoint.checkpointRef),
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete stale checkpoint refs after revert", {
              threadId,
              turnCount,
              detail: error.message,
            }),
          ),
        );
    }

    const completed = yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: serverCommandId("checkpoint-revert-complete"),
        threadId,
        turnCount,
        droppedTurnIds: outcome.dropped.map((checkpoint) => checkpoint.turnId),
        latestTurn: outcome.latestTurn,
        createdAt: new Date().toISOString(),
      })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          // Leave the journal in `restoring-files`: startup recovery finishes it,
          // and the pending state goes stale on its own.
          Effect.logError("failed to project checkpoint revert", {
            threadId,
            turnCount,
            detail: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
    if (!completed) return;

    yield* updateRevert(
      filesNotRestoredReason === null
        ? { threadId, revertRequestId, turnCount, fromTurnCount, status: "completed", cwd }
        : {
            threadId,
            revertRequestId,
            turnCount,
            fromTurnCount,
            status: "files-not-restored",
            reason: filesNotRestoredReason.reason,
            detail: `The agent forgot the discarded turns, but files were not restored: ${filesNotRestoredReason.text.replace(/[.\s]+$/, "")}. The checkout still contains changes from those turns. Review them in Changes or with git before continuing.`,
            cwd,
          },
    );
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
    revertRequestId: CommandId,
    progress: RevertProgress,
  ) {
    const threadId = event.payload.threadId;
    const turnCount = event.payload.turnCount;
    const fail = (reason: CheckpointRevertFailureReason, detail: string) =>
      updateRevert({
        threadId,
        revertRequestId,
        turnCount,
        status: "failed",
        reason,
        detail: withNothingChanged(detail),
      });

    // 1. Load the authoritative thread state.
    const thread = yield* resolveThreadDetail(threadId);
    const shell = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadShellById(threadId),
    );
    if (!thread || !shell) {
      return yield* fail("target-unavailable", "This thread is no longer available.");
    }

    // 2. Re-check the thread itself: the decider admitted against the command model.
    const busy = threadBusyReason(threadShellSettlementInput(shell, new Date().toISOString()));
    if (busy !== null) {
      return yield* fail("thread-busy", threadBusyMessage(busy));
    }
    if (shell.backgroundLiveness === "working") {
      return yield* fail(
        "thread-busy",
        "This thread still has background work running. Wait for it to finish, or stop it, before reverting.",
      );
    }

    // 3. The target must exist.
    const outcome = revertOutcome(thread, turnCount);
    if (turnCount > outcome.currentTurnCount) {
      return yield* fail(
        "target-unavailable",
        `Checkpoint ${turnCount} does not exist; this thread is at checkpoint ${outcome.currentTurnCount}.`,
      );
    }

    // 4. Never drop the turn that carried a context handoff.
    const epochViolation = providerRollbackEpochViolation(thread, turnCount);
    if (epochViolation !== null) {
      return yield* fail("handoff-boundary", epochViolation);
    }

    // 5. The live session cwd, else the thread or project workspace.
    const projects = yield* resolveThreadProjects(thread.projectId);
    const cwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!cwd) {
      return yield* fail(
        "not-git",
        "Checkpoints are unavailable because this workspace is not a git repository.",
      );
    }

    // 6. The files for checkpoint K must be restorable.
    const plan = yield* resolveRestorePlan({ thread, turnCount, cwd });
    if (plan === null) {
      return yield* fail(
        "target-unavailable",
        `The files for checkpoint ${turnCount} are no longer available.`,
      );
    }

    // 7. Other threads in this working tree must not lose work.
    const safety = yield* evaluateRestoreSafety({ thread, turnCount, cwd, source: plan.source });
    if (safety.kind === "conflict") {
      return yield* fail(
        "shared-checkout",
        safety.threads.length === 0
          ? "Ryco could not check which other threads use this checkout."
          : checkpointRestoreConflictMessage(safety, turnCount),
      );
    }

    // 8. Provider first: files and history stay untouched if it refuses.
    const fromTurnCount = outcome.currentTurnCount;
    if (outcome.dropped.length > 0) {
      // The journal must say "rolling-back" before the provider can forget
      // anything, or a crash would be recovered as "nothing was changed".
      const journaled = yield* Effect.result(
        recordRevertPhase({
          threadId,
          revertRequestId,
          turnCount,
          fromTurnCount,
          status: "rolling-back",
          cwd,
        }),
      );
      if (journaled._tag === "Failure") {
        yield* Effect.logWarning("failed to journal checkpoint revert before provider rollback", {
          threadId,
          revertRequestId,
          detail: journaled.failure.message,
        });
        return yield* fail(
          "internal-error",
          "Ryco could not record the revert before rewinding the agent's conversation.",
        );
      }
      progress.phase = "rolling-back";
      const rolledBack = yield* Effect.result(
        providerService.rollbackConversation({
          threadId,
          numTurns: outcome.currentTurnCount - turnCount,
          targetTurnId: outcome.targetTurnId,
          droppedTurnIds: outcome.dropped.map((checkpoint) => checkpoint.turnId),
        }),
      );
      if (rolledBack._tag === "Failure") {
        const error = rolledBack.failure;
        return yield* error._tag === "ProviderOperationUnsupportedError"
          ? fail("provider-unsupported", error.message)
          : fail(
              "provider-failed",
              `Ryco could not rewind the agent's conversation. ${asSentence(
                userFacingFailureDetail(Cause.fail(error)),
              )}`,
            );
      }
    }
    progress.phase = "restoring-files";
    yield* updateRevert({
      threadId,
      revertRequestId,
      turnCount,
      fromTurnCount,
      status: "restoring-files",
      cwd,
    });

    // 9. Project the revert and restore files.
    yield* finishRevert({ thread, revertRequestId, turnCount, cwd });
  });

  // An unexpected failure is journaled by how far the revert got: before the
  // provider nothing changed; during it the agent may have forgotten turns;
  // after it the journal stays "restoring-files" so recovery can finish it.
  const handleRevertRequestedSafely = (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) => {
    const threadId = event.payload.threadId;
    const turnCount = event.payload.turnCount;
    const revertRequestId = event.commandId ?? serverCommandId("checkpoint-revert-request");
    const progress: RevertProgress = { phase: "validating" };
    return handleRevertRequested(event, revertRequestId, progress).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const logged = Effect.logError("checkpoint revert failed unexpectedly", {
          threadId,
          revertRequestId,
          phase: progress.phase,
          cause: Cause.pretty(cause),
        });
        const base = { threadId, revertRequestId, turnCount };
        switch (progress.phase) {
          case "validating":
            return logged.pipe(
              Effect.andThen(
                updateRevert({
                  ...base,
                  status: "failed",
                  reason: "internal-error",
                  detail: withNothingChanged(userFacingFailureDetail(cause)),
                }),
              ),
            );
          case "rolling-back":
            return logged.pipe(
              Effect.andThen(
                updateRevert({
                  ...base,
                  status: "interrupted",
                  reason: "provider-failed",
                  detail: `Ryco hit an unexpected error while rewinding the agent's conversation. The agent may already have forgotten the newer turns, but files and history were not changed. Revert to checkpoint ${turnCount} again to finish.`,
                }),
              ),
            );
          case "restoring-files":
            return logged;
        }
      }),
    );
  };

  /** Finishes a revert that stopped after the provider rewound, unless the thread moved on. */
  const recoverRestoringFiles = Effect.fn("recoverRestoringFiles")(function* (
    entry: PendingCheckpointRevert,
  ) {
    const { threadId, activity, payload } = entry;
    const turnCount = payload.turnCount;
    const interrupt = (detail: string) =>
      updateRevert({
        threadId,
        revertRequestId: payload.revertRequestId,
        turnCount,
        fromTurnCount: payload.fromTurnCount,
        cwd: payload.cwd,
        status: "interrupted",
        reason: "restart",
        detail,
      });
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return yield* interrupt(
        `Ryco stopped while restoring files and could not finish. Revert to checkpoint ${turnCount} again to finish.`,
      );
    }
    const outcome = revertOutcome(thread, turnCount);
    const fromTurnCount = payload.fromTurnCount;
    if (
      fromTurnCount !== undefined &&
      fromTurnCount > turnCount &&
      outcome.currentTurnCount === turnCount
    ) {
      // thread.reverted was projected; only the final journal update was lost.
      return yield* interrupt(
        `The conversation was reverted to checkpoint ${turnCount}, but Ryco stopped before it recorded whether files were restored. Check the files in Changes, or revert to checkpoint ${turnCount} again to restore them.`,
      );
    }
    // Finishing recomputes the dropped turns from SQL, so it is only safe while
    // the thread is exactly where the revert left it.
    if (
      fromTurnCount === undefined ||
      outcome.currentTurnCount !== fromTurnCount ||
      threadChangedSince(thread, activity.createdAt)
    ) {
      return yield* interrupt(
        `Ryco stopped while restoring files, and this thread changed afterwards, so the revert was not finished. Files and history were not changed, but the agent may already have forgotten the turns after checkpoint ${turnCount}. Review the thread before continuing, or start a new thread.`,
      );
    }
    const pendingSinceMs = Date.parse(activity.createdAt);
    if (
      !Number.isFinite(pendingSinceMs) ||
      Date.now() - pendingSinceMs >= CHECKPOINT_REVERT_PENDING_STALE_MS
    ) {
      // Too old to restore files blindly: the checkout may hold newer work.
      return yield* interrupt(
        `Ryco stopped while restoring files too long ago to finish safely. Files and history were not changed, but the agent may already have forgotten the turns after checkpoint ${turnCount}. Revert to checkpoint ${turnCount} again to finish.`,
      );
    }
    const cwd =
      payload.cwd ??
      (yield* resolveCheckpointCwd({
        threadId,
        thread,
        projects: yield* resolveThreadProjects(thread.projectId),
        preferSessionRuntime: false,
      }));
    if (!cwd) {
      return yield* interrupt(
        `Ryco stopped while restoring files and could not finish. Revert to checkpoint ${turnCount} again to finish.`,
      );
    }
    yield* finishRevert({
      thread,
      revertRequestId: payload.revertRequestId,
      turnCount,
      cwd,
    });
  });

  const recoverEntry = (entry: PendingCheckpointRevert) => {
    const { threadId, payload } = entry;
    const base = {
      threadId,
      revertRequestId: payload.revertRequestId,
      turnCount: payload.turnCount,
      fromTurnCount: payload.fromTurnCount,
      cwd: payload.cwd,
    };
    switch (payload.status) {
      case "requested":
        return updateRevert({
          ...base,
          status: "failed",
          reason: "restart",
          detail: "Ryco restarted before this revert started. Nothing was changed.",
        });
      case "rolling-back":
        return updateRevert({
          ...base,
          status: "interrupted",
          reason: "restart",
          detail: `Ryco stopped while rewinding the agent's conversation. The agent may already have forgotten the newer turns, but files and history were not changed. Revert to checkpoint ${payload.turnCount} again to finish.`,
        });
      case "restoring-files":
        return recoverRestoringFiles(entry).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError("checkpoint revert recovery failed", {
                  threadId,
                  revertRequestId: payload.revertRequestId,
                  cause: Cause.pretty(cause),
                }).pipe(
                  // Never retry a failing entry on every startup.
                  Effect.andThen(
                    updateRevert({
                      ...base,
                      status: "interrupted",
                      reason: "restart",
                      detail: `Ryco stopped while restoring files and could not finish after restarting. The agent may already have forgotten the turns after checkpoint ${payload.turnCount}. Revert to checkpoint ${payload.turnCount} again to finish.`,
                    }),
                  ),
                ),
          ),
        );
      default:
        return Effect.void;
    }
  };

  const recover: CheckpointReactorShape["recover"] = () =>
    Effect.gen(function* () {
      const listPending = projectionSnapshotQuery.listPendingCheckpointReverts;
      if (!listPending) return;
      const pending = yield* listPending();
      // Each entry is isolated: one thread's failure never skips the others.
      yield* Effect.forEach(pending, recoverEntry, { discard: true });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError("checkpoint revert recovery failed", { cause: Cause.pretty(cause) }),
      ),
    );

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequestedSafely(event);
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
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker({
    policy: losslessBackpressureQueuePolicy({
      component: "CheckpointReactor",
      capacity: 1_024,
    }),
    process: processInputSafely,
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
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.started" && event.type !== "turn.completed") {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    recover,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
