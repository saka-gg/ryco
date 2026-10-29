/**
 * The checkpoint revert saga: admission re-checks, the provider rollback, the file
 * restore, the journal and startup recovery. `CheckpointReactor` loads it on the first
 * revert (or the first pending revert at startup) through `import()`, so a boot without
 * either never evaluates it.
 *
 * @module checkpointRevertSaga
 */
import {
  CommandId,
  ContextHandoffActivityPayload,
  type CheckpointRef,
  type CheckpointRevertActivityPayload,
  type CheckpointRevertFailureReason,
  type CheckpointRevertStatus,
  type OrchestrationCheckpointSummary,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProjectId,
  type ThreadId,
} from "@ryco/contracts";
import { Cause, Effect, Option, Schema } from "effect";
import { getThreadLastActivityTimestamp } from "@ryco/shared/threadSettlement";
import { laterIsoTimestamp } from "@ryco/shared/turnFinalization";

import type { CheckpointStoreError } from "../checkpointing/Errors.ts";
import {
  checkpointRestoreConflictMessage,
  checkpointRestoreConflictReason,
  evaluateCheckpointRestoreSafety,
  sharesWorkingTree,
  type CheckoutPathOps,
  type CheckpointRestoreSafety,
  type RestoreNeighbour,
  type RestoreSource,
} from "../checkpointing/restoreSafety.ts";
import type { CheckpointStoreShape } from "../checkpointing/Services/CheckpointStore.ts";
import {
  checkpointRefForThreadRevertRescue,
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../checkpointing/Utils.ts";
import { isGitRepository } from "../git/Utils.ts";
import {
  canonicalizeFilesystemPath,
  isCaseSensitiveFileSystem,
} from "../git/worktreeReconciliation.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { findThreadSession } from "../provider/threadSessionLookup.ts";
import type { VcsStatusBroadcasterShape } from "../vcs/VcsStatusBroadcaster.ts";
import type { WorkspaceEntriesShape } from "../workspace/Services/WorkspaceEntries.ts";
import {
  CHECKPOINT_REVERT_PENDING_STALE_MS,
  checkpointRevertFromTurnCount,
  checkpointRevertLeftDroppedChangesAt,
  makeCheckpointRevertActivity,
  threadBusyMessage,
  threadBusyReason,
} from "./checkpointRevertPolicy.ts";
import { resolveCwdRelocation } from "./cwdRelocation.ts";
import { nativeForkBaseTurnId } from "./forkInheritance.ts";
import { latestTurnFromCheckpoint } from "./projector.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import {
  readScopedShellSnapshot,
  readWorkspacePlacement,
  type ProjectionSnapshotQueryShape,
} from "./Services/ProjectionSnapshotQuery.ts";
import { threadShellSettlementInput } from "./threadSettlementInput.ts";
import { userFacingFailureDetail } from "./userFacingErrors.ts";

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

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

/** How far a live revert got, so an unexpected failure is journaled honestly. */
type RevertProgress = { phase: "validating" | "rolling-back" | "restoring-files" };

export type PendingCheckpointRevert = {
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

/**
 * What a revert changes: the conversation and the files (`thread.checkpoint.revert`),
 * only the conversation (`thread.conversation.revert`), or only the files
 * (`thread.files.revert`).
 */
type RevertScope = "all" | "conversation" | "files";

function revertScope(payload: {
  readonly restoreFiles?: boolean | undefined;
  readonly rollbackConversation?: boolean | undefined;
}): RevertScope {
  if (payload.rollbackConversation === false) return "files";
  return payload.restoreFiles === false ? "conversation" : "all";
}

/** The journal fields every phase of a revert carries, so recovery keeps its scope. */
function scopeJournal(scope: RevertScope) {
  return scope === "conversation"
    ? { restoreFiles: false as const }
    : scope === "files"
      ? { rollbackConversation: false as const }
      : {};
}

/** Why a revert left the checkout without checkpoint K's files. */
type FilesNotRestored = {
  readonly reason: CheckpointRevertFailureReason;
  /** Short user-facing cause, without a trailing period. */
  readonly text: string;
  /** Git may already have rewritten part of the checkout. */
  readonly partial: boolean;
  /**
   * Snapshots of the checkout kept because the files may be partly restored: the
   * revert's, then the one a recovery took of the checkout as it found it.
   */
  readonly rescueRefs?: ReadonlyArray<CheckpointRef> | undefined;
};

const withoutTrailingPeriod = (text: string) => text.replace(/[.\s]+$/, "");

/** Names the snapshots a failed restore kept, so the files can be recovered by hand. */
function rescueNote(rescueRefs: ReadonlyArray<CheckpointRef> | undefined): string {
  const [revert, recovery] = rescueRefs ?? [];
  if (revert === undefined) return "";
  return recovery === undefined
    ? ` The files from before are kept in the git ref ${revert}.`
    : ` The files from before the revert are kept in the git ref ${revert}, and the files from before Ryco resumed it in ${recovery}.`;
}

/** Detail for a files-only revert (nothing dropped) whose files were not restored. */
function filesOnlyRevertFailureDetail(files: FilesNotRestored): string {
  return files.partial
    ? `Files may be only partly restored: ${withoutTrailingPeriod(files.text)}. Review them in Changes or with git before continuing.${rescueNote(files.rescueRefs)}`
    : `Files were not restored: ${withoutTrailingPeriod(files.text)}. Nothing was changed.`;
}

/** Detail for a projected revert whose files were not restored. */
function filesNotRestoredDetail(files: FilesNotRestored): string {
  return files.partial
    ? `The agent forgot the discarded turns, but files may be only partly restored: ${withoutTrailingPeriod(files.text)}. Review them in Changes or with git before continuing.${rescueNote(files.rescueRefs)}`
    : `The agent forgot the discarded turns, but files were not restored: ${withoutTrailingPeriod(files.text)}. The checkout still contains changes from those turns. Review them in Changes or with git before continuing.`;
}

/** Whether checkpoint K's files are in the checkout now. */
type RestoreFilesResult =
  | {
      readonly kind: "restored";
      /** The checkout already held them: nothing was rewritten. */
      readonly unchanged: boolean;
    }
  | { readonly kind: "not-restored"; readonly files: FilesNotRestored };

const KEPT_FILES_LISTED_MAX = 3;

/**
 * Detail for a conversation-only revert: the files the dropped turns changed, which
 * keep those changes. Read from the dropped checkpoints, so it costs no git call.
 */
export function keptFilesDetail(
  dropped: ReadonlyArray<Pick<OrchestrationCheckpointSummary, "files">>,
): string | undefined {
  const paths = [...new Set(dropped.flatMap((checkpoint) => checkpoint.files.map((f) => f.path)))];
  if (paths.length === 0) return undefined;
  const listed = paths.slice(0, KEPT_FILES_LISTED_MAX);
  const more = paths.length - listed.length;
  const names =
    more > 0
      ? `${listed.join(", ")} and ${more} more ${more === 1 ? "file" : "files"}`
      : listed.length === 1
        ? listed[0]
        : `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}`;
  return `The removed turns' changes stay in ${names}.`;
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

/** The reactor's services and the helpers it shares with the saga. */
export interface CheckpointRevertSagaDeps {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly providerService: ProviderServiceShape;
  readonly checkpointStore: CheckpointStoreShape;
  readonly workspaceEntries: WorkspaceEntriesShape;
  readonly vcsStatusBroadcaster: VcsStatusBroadcasterShape;
  /** Drops the reactor's memo of the thread's newest checkpoint ref: a revert deletes refs. */
  readonly forgetCheckpointRefs: (threadId: ThreadId) => Effect.Effect<void>;
  /** The reactor's checkpoint cwd: the live session's, else the thread's or project's. */
  readonly resolveCheckpointCwd: (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }) => Effect.Effect<string | undefined>;
}

export interface CheckpointRevertSaga {
  /** Runs one requested revert and journals how it ended. */
  readonly handleRevertRequested: (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) => Effect.Effect<void, CheckpointStoreError | ProjectionRepositoryError>;
  /** Finishes or terminalizes reverts a restart left pending, each on its own. */
  readonly recover: (
    pending: ReadonlyArray<PendingCheckpointRevert>,
  ) => Effect.Effect<void, CheckpointStoreError | ProjectionRepositoryError>;
}

export function makeCheckpointRevertSaga(deps: CheckpointRevertSagaDeps): CheckpointRevertSaga {
  const {
    orchestrationEngine,
    projectionSnapshotQuery,
    providerService,
    checkpointStore,
    workspaceEntries,
    vcsStatusBroadcaster,
    forgetCheckpointRefs,
    resolveCheckpointCwd,
  } = deps;

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  type RevertPhaseInput = {
    readonly threadId: ThreadId;
    readonly revertRequestId: CommandId;
    readonly turnCount: number;
    readonly fromTurnCount?: number | undefined;
    readonly status: CheckpointRevertStatus;
    readonly reason?: CheckpointRevertFailureReason | undefined;
    readonly detail?: string | undefined;
    readonly cwd?: string | undefined;
    /** `false` on every phase of a conversation-only revert. */
    readonly restoreFiles?: false | undefined;
    /** `false` on every phase of a files-only revert. */
    readonly rollbackConversation?: false | undefined;
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

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  // Whether the conversation a revert would rewind last ran outside the
  // thread's folder: the same check a turn start makes before resuming it.
  const resolveRevertCwdRelocation = Effect.fn("resolveRevertCwdRelocation")(function* (
    thread: OrchestrationThread,
    cwd: string | undefined,
  ) {
    const liveSession =
      thread.session !== null && thread.session.status !== "stopped"
        ? yield* findThreadSession(providerService, thread.id)
        : undefined;
    return yield* resolveCwdRelocation(providerService, {
      threadId: thread.id,
      liveSession,
      instanceId: thread.modelSelection.instanceId,
      cwd,
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

  // Every other live thread whose workspace or live provider session cwd shares the restored
  // working tree. Placement (five columns per thread) finds them; only those threads' summaries
  // are read to judge busy state and recency, never the whole shell.
  const buildRestoreNeighbours = Effect.fn("buildRestoreNeighbours")(function* (
    threadId: ThreadId,
    checkoutRoot: string,
    ops: CheckoutPathOps,
  ) {
    const placement = yield* readWorkspacePlacement(projectionSnapshotQuery);
    const sessions = yield* providerService.listSessions();
    const nowIso = new Date().toISOString();
    const sessionCwdsByThread = new Map<string, Array<string>>();
    for (const session of sessions) {
      if (session.status === "closed" || !session.cwd) continue;
      const cwds = sessionCwdsByThread.get(session.threadId) ?? [];
      cwds.push(session.cwd);
      sessionCwdsByThread.set(session.threadId, cwds);
    }
    const pathsByThread = new Map<ThreadId, ReadonlyArray<string>>();
    for (const thread of placement.threads) {
      if (thread.id === threadId) continue;
      const workspace = resolveThreadWorkspaceCwd({ thread, projects: placement.projects });
      const paths = Array.from(
        new Set<string>([
          ...(workspace ? [workspace] : []),
          ...(sessionCwdsByThread.get(thread.id) ?? []),
        ]),
      );
      if (paths.some((candidate) => sharesWorkingTree(checkoutRoot, candidate, ops))) {
        pathsByThread.set(thread.id, paths);
      }
    }
    if (pathsByThread.size === 0) return [];
    const scoped = yield* readScopedShellSnapshot(projectionSnapshotQuery, {
      threadIds: [...pathsByThread.keys()],
    });
    const readLatestRevert = projectionSnapshotQuery.getLatestCheckpointRevert;
    return yield* Effect.forEach(scoped.threads, (thread) =>
      Effect.gen(function* () {
        const input = threadShellSettlementInput(thread, nowIso);
        const lastActivityAt = getThreadLastActivityTimestamp(input);
        // A revert that kept the dropped turns' changes moves the thread's recency back
        // past them; the changes are still in the checkout, so they still count, also
        // after a later revert of that thread failed.
        const keptChangesAt = readLatestRevert
          ? checkpointRevertLeftDroppedChangesAt(
              yield* readLatestRevert(thread.id, { skipFailed: true }),
            )
          : null;
        return {
          threadId: thread.id,
          title: thread.title,
          paths: pathsByThread.get(thread.id) ?? [],
          busy: threadBusyReason(input) !== null || thread.backgroundLiveness === "working",
          lastActivityAt:
            keptChangesAt === null
              ? lastActivityAt
              : laterIsoTimestamp(lastActivityAt, keptChangesAt),
        } satisfies RestoreNeighbour;
      }),
    );
  });

  const evaluateRestoreSafety = Effect.fn("evaluateRestoreSafety")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly turnCount: number;
    readonly cwd: string;
    readonly source: RestoreSource;
  }): Effect.fn.Return<CheckpointRestoreSafety, never> {
    const ops = sameCheckoutOps();
    const neighbours = yield* buildRestoreNeighbours(input.thread.id, input.cwd, ops).pipe(
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
      ops,
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
      // Checkpoint 0 of a native fork still holds the inherited conversation: rewind the
      // provider to the end of it rather than starting it fresh.
      targetTurnId:
        turnCount === 0 ? nativeForkBaseTurnId(thread.activities) : (target?.turnId ?? null),
      latestTurn: turnCount === 0 || !target ? null : latestTurnFromCheckpoint(target),
    };
  };

  const discardRescue = (cwd: string, rescueRef: CheckpointRef) =>
    checkpointStore.deleteCheckpointRefs({ cwd, checkpointRefs: [rescueRef] }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete a checkpoint revert rescue ref", {
          cwd,
          rescueRef,
          detail: error.message,
        }),
      ),
    );

  // Keeps the @-mention file picker and the checkout's git status in step with
  // files a revert rewrote.
  const refreshRestoredCheckout = (cwd: string) =>
    workspaceEntries.invalidate(cwd).pipe(
      Effect.andThen(vcsStatusBroadcaster.refreshLocalStatus(cwd)),
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh git status after a checkpoint restore", {
          cwd,
          detail: error.message,
        }),
      ),
    );

  /**
   * Puts checkpoint K's files into the checkout, safely. The checkout is first saved
   * into the revert's rescue ref (`checkpointRefForThreadRevertRescue`). A recovering
   * revert whose first attempt left that snapshot keeps it (it holds the files from
   * before the revert) and saves the checkout as it found it under the `"recovery"`
   * ref, since the first attempt or the user may have changed files since. A restore
   * that fails part way puts the newest snapshot back. Every snapshot is deleted once
   * the files are restored; when they may be left partly restored, the snapshots that
   * remain are kept and named. A checkout that already holds K's files is left alone.
   * Never fails: a failure says whether the files may be partly restored.
   */
  const restoreCheckpointFiles = Effect.fn("restoreCheckpointFiles")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly revertRequestId: CommandId;
    readonly turnCount: number;
    readonly cwd: string;
    readonly recovering: boolean;
  }) {
    const { thread, turnCount, cwd } = input;
    const revertSnapshot = checkpointRefForThreadRevertRescue(thread.id, input.revertRequestId);
    const recoverySnapshot = checkpointRefForThreadRevertRescue(
      thread.id,
      input.revertRequestId,
      "recovery",
    );
    // The snapshots that exist now, oldest first.
    const kept: Array<CheckpointRef> = [];
    const drop = (ref: CheckpointRef) =>
      discardRescue(cwd, ref).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const index = kept.indexOf(ref);
            if (index >= 0) kept.splice(index, 1);
          }),
        ),
      );
    const dropAll = Effect.suspend(() => Effect.forEach([...kept], drop, { discard: true }));
    // A first attempt that left its snapshot may have rewritten part of the checkout.
    let resumed = false;
    // Set once git may have started rewriting the checkout.
    let restoreStarted = false;
    const notRestored = (files: FilesNotRestored): RestoreFilesResult => ({
      kind: "not-restored",
      files,
    });
    // Nothing was rewritten now; a resumed revert's files may still be partly restored.
    const leftAsFound = (files: Omit<FilesNotRestored, "partial">): RestoreFilesResult =>
      notRestored(
        resumed ? { ...files, partial: true, rescueRefs: [...kept] } : { ...files, partial: false },
      );
    const unavailableText = `the files for checkpoint ${turnCount} are no longer available`;

    const restore = Effect.fn("restoreCheckpointFiles.restore")(function* (): Effect.fn.Return<
      RestoreFilesResult,
      CheckpointStoreError
    > {
      if (input.recovering) {
        resumed = yield* checkpointStore.hasCheckpointRef({ cwd, checkpointRef: revertSnapshot });
        if (resumed) kept.push(revertSnapshot);
      }

      const plan = yield* resolveRestorePlan({ thread, turnCount, cwd });
      if (plan === null) return leftAsFound({ reason: "files-failed", text: unavailableText });
      const safety = yield* evaluateRestoreSafety({ thread, turnCount, cwd, source: plan.source });
      const conflictText = restoreConflictText(safety, turnCount);
      if (conflictText !== null)
        return leftAsFound({ reason: "shared-checkout", text: conflictText });

      // The checkout as it is now: what a failed restore puts back.
      const snapshot = resumed ? recoverySnapshot : revertSnapshot;
      const captured = yield* Effect.result(
        checkpointStore.captureCheckpoint({ cwd, checkpointRef: snapshot }),
      );
      if (captured._tag === "Failure") {
        // Without a way back, the checkout is not touched.
        yield* Effect.logWarning("failed to save the checkout before a checkpoint restore", {
          threadId: thread.id,
          turnCount,
          detail: captured.failure.message,
        });
        return leftAsFound({
          reason: "files-failed",
          text: `Ryco could not save the current files before restoring them (${withoutTrailingPeriod(
            userFacingFailureDetail(Cause.fail(captured.failure)),
          )})`,
        });
      }
      kept.push(snapshot);
      const unchanged =
        plan.source === "ref" &&
        (yield* checkpointStore
          .sameCheckpointTree({ cwd, leftRef: snapshot, rightRef: plan.targetRef })
          .pipe(Effect.catch(() => Effect.succeed(false))));
      if (unchanged) {
        yield* dropAll;
        return { kind: "restored", unchanged: true } as const;
      }

      restoreStarted = true;
      const restored = yield* Effect.result(
        checkpointStore.restoreCheckpoint({
          cwd,
          checkpointRef: plan.targetRef,
          fallbackToHead: plan.source === "head-fallback",
        }),
      );
      if (restored._tag === "Success") {
        if (!restored.success) {
          // The target did not resolve, before any file changed: only this save is moot.
          yield* drop(snapshot);
          return leftAsFound({ reason: "files-failed", text: unavailableText });
        }
        yield* dropAll;
        yield* refreshRestoredCheckout(cwd);
        return { kind: "restored", unchanged: false } as const;
      }

      // Git may have rewritten part of the checkout: put the newest snapshot back.
      const failure = withoutTrailingPeriod(userFacingFailureDetail(Cause.fail(restored.failure)));
      const putBack = yield* Effect.result(
        checkpointStore.restoreCheckpoint({ cwd, checkpointRef: snapshot }),
      );
      if (putBack._tag === "Success" && putBack.success) {
        yield* drop(snapshot);
        yield* refreshRestoredCheckout(cwd);
        return leftAsFound({
          reason: "files-failed",
          text: resumed
            ? `${failure}. Ryco put the files back as they were when it resumed the revert`
            : `${failure}. Ryco put the files back as they were`,
        });
      }
      yield* Effect.logWarning(
        "failed to put the checkout back after a failed checkpoint restore",
        {
          threadId: thread.id,
          turnCount,
          snapshot,
          detail:
            putBack._tag === "Failure" ? putBack.failure.message : "the snapshot did not resolve",
        },
      );
      return notRestored({
        reason: "files-failed",
        text: failure,
        partial: true,
        rescueRefs: [...kept],
      });
    });
    return yield* restore().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        const partial = restoreStarted || resumed;
        return Effect.logWarning("failed to restore checkpoint files", {
          threadId: thread.id,
          turnCount,
          cause: Cause.pretty(cause),
        }).pipe(
          // Snapshots of files that are certainly untouched are moot.
          Effect.andThen(partial ? Effect.void : dropAll),
          Effect.as(
            notRestored({
              reason: "files-failed",
              text: userFacingFailureDetail(cause),
              partial,
              ...(partial && kept.length > 0 ? { rescueRefs: [...kept] } : {}),
            }),
          ),
        );
      }),
    );
  });

  // Shared by the live path and startup recovery: the provider conversation
  // already matches checkpoint K (or nothing was dropped), so project the
  // revert and restore files when that is still safe. `skipFiles` projects
  // without touching the checkout; so does `keepFiles`, the user's choice of a
  // conversation-only revert, which then counts as completed.
  const finishRevert = Effect.fn("finishRevert")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly revertRequestId: CommandId;
    readonly turnCount: number;
    readonly cwd: string | undefined;
    readonly skipFiles?: FilesNotRestored | undefined;
    readonly keepFiles?: boolean | undefined;
    /** Startup recovery: the first attempt may have left its snapshot of the checkout. */
    readonly recovering?: boolean | undefined;
  }) {
    const { thread, revertRequestId, turnCount, cwd } = input;
    const keepFiles = input.keepFiles === true;
    const threadId = thread.id;
    const outcome = revertOutcome(thread, turnCount);
    // The revert may delete refs this reactor remembers.
    yield* forgetCheckpointRefs(threadId);

    // The provider may already have forgotten the dropped turns, so nothing
    // here may skip projecting the revert: any file failure is reported.
    const filesNotRestoredReason: FilesNotRestored | null = keepFiles
      ? null
      : (input.skipFiles ??
        (cwd === undefined
          ? {
              // Only recovery lacks a cwd, after an earlier attempt that may have started.
              reason: "files-failed",
              text: "Ryco could not find this thread's git workspace",
              partial: true,
            }
          : yield* restoreCheckpointFiles({
              thread,
              revertRequestId,
              turnCount,
              cwd,
              recovering: input.recovering === true,
            }).pipe(Effect.map((result) => (result.kind === "restored" ? null : result.files)))));

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
        detail: filesOnlyRevertFailureDetail(filesNotRestoredReason),
        cwd,
      });
      return;
    }

    if (outcome.dropped.length > 0 && cwd !== undefined) {
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
      keepFiles
        ? {
            threadId,
            revertRequestId,
            turnCount,
            fromTurnCount,
            status: "completed",
            detail: keptFilesDetail(outcome.dropped),
            cwd,
            restoreFiles: false,
          }
        : filesNotRestoredReason === null
          ? { threadId, revertRequestId, turnCount, fromTurnCount, status: "completed", cwd }
          : {
              threadId,
              revertRequestId,
              turnCount,
              fromTurnCount,
              status: "files-not-restored",
              reason: filesNotRestoredReason.reason,
              detail: filesNotRestoredDetail(filesNotRestoredReason),
              cwd,
            },
    );
  });

  // A files-only revert, live or recovered: checkpoint K's files go back, and every
  // message and turn stays. So do the later turns' checkpoint refs: their diffs still
  // show what those turns changed. The next turn's changes count from the newest
  // checkpoint, so they include this restore, like any edit made between turns.
  const finishFilesRevert = Effect.fn("finishFilesRevert")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly revertRequestId: CommandId;
    readonly turnCount: number;
    readonly fromTurnCount: number | undefined;
    readonly cwd: string;
    readonly recovering: boolean;
  }) {
    const { thread, revertRequestId, turnCount, cwd } = input;
    const base = {
      threadId: thread.id,
      revertRequestId,
      turnCount,
      fromTurnCount: input.fromTurnCount,
      cwd,
      rollbackConversation: false as const,
    };
    const result = yield* restoreCheckpointFiles({
      thread,
      revertRequestId,
      turnCount,
      cwd,
      recovering: input.recovering,
    });
    yield* updateRevert(
      result.kind === "restored"
        ? {
            ...base,
            status: "completed",
            // A recovering revert's first attempt may have restored them already.
            detail:
              result.unchanged && !input.recovering
                ? `The files already matched checkpoint ${turnCount}, so nothing was changed.`
                : "The chat was kept as it is. The agent isn't told that the files changed.",
          }
        : {
            ...base,
            status: "failed",
            reason: result.files.reason,
            detail: filesOnlyRevertFailureDetail(result.files),
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
    // Every phase journals the scope. A conversation-only revert never reads or
    // writes the checkout's files; a files-only one never calls the provider.
    const scope = revertScope(event.payload);
    const keepFiles = scope === "conversation";
    const journal = scopeJournal(scope);
    const fail = (reason: CheckpointRevertFailureReason, detail: string) =>
      updateRevert({
        threadId,
        revertRequestId,
        turnCount,
        status: "failed",
        reason,
        detail: withNothingChanged(detail),
        ...journal,
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

    // 4. Never drop the turn that carried a context handoff. Restoring only files
    // drops no turn.
    const epochViolation =
      scope === "files" ? null : providerRollbackEpochViolation(thread, turnCount);
    if (epochViolation !== null) {
      return yield* fail("handoff-boundary", epochViolation);
    }

    // 5. The live session cwd, else the thread or project workspace. Keeping
    // the files needs no checkout; with one, the dropped refs are deleted.
    const projects = yield* resolveThreadProjects(thread.projectId);
    const cwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!keepFiles) {
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

      // 7. Other threads in this working tree must not lose work. Keeping the
      // files changes nothing they see: their checkpoints are their own refs.
      const safety = yield* evaluateRestoreSafety({ thread, turnCount, cwd, source: plan.source });
      if (safety.kind === "conflict") {
        return yield* fail(
          "shared-checkout",
          safety.threads.length === 0
            ? "Ryco could not check which other threads use this checkout."
            : checkpointRestoreConflictMessage(safety, turnCount),
        );
      }
    }

    const fromTurnCount = outcome.currentTurnCount;
    if (scope === "files" && cwd) {
      // 8. No provider call: the conversation stays as it is. The journal must say
      // "restoring-files" before git touches the checkout, or a crash would be
      // recovered as "nothing was changed".
      const journaled = yield* Effect.result(
        recordRevertPhase({
          threadId,
          revertRequestId,
          turnCount,
          fromTurnCount,
          status: "restoring-files",
          cwd,
          ...journal,
        }),
      );
      if (journaled._tag === "Failure") {
        yield* Effect.logWarning("failed to journal checkpoint revert before restoring files", {
          threadId,
          revertRequestId,
          detail: journaled.failure.message,
        });
        return yield* fail(
          "internal-error",
          "Ryco could not record the revert before restoring files.",
        );
      }
      progress.phase = "restoring-files";
      return yield* finishFilesRevert({
        thread,
        revertRequestId,
        turnCount,
        fromTurnCount,
        cwd,
        recovering: false,
      });
    }

    // 8. Provider first: files and history stay untouched if it refuses.
    // The thread's folder, resolved like a turn start: the binding may still
    // record the folder the conversation ran in before the thread moved.
    const workspaceCwd = resolveThreadWorkspaceCwd({ thread, projects });
    const resolvedRelocation =
      outcome.dropped.length > 0
        ? yield* Effect.result(resolveRevertCwdRelocation(thread, workspaceCwd))
        : undefined;
    if (resolvedRelocation?._tag === "Failure") {
      return yield* fail(
        "provider-failed",
        `Ryco could not rewind the agent's conversation. ${asSentence(
          userFacingFailureDetail(Cause.fail(resolvedRelocation.failure)),
        )}`,
      );
    }
    const relocation = resolvedRelocation?.success;
    if (relocation !== undefined && !relocation.resumeSurvives) {
      // The provider cannot resume this conversation in the new folder, so
      // rewinding it would resume it in the old one. Refuse before anything
      // changes rather than restore files the conversation would not match.
      return yield* fail(
        "provider-unsupported",
        "This conversation ran in a folder the thread has since moved from, and the agent can't rewind it there. Send a message first to continue it in the new folder.",
      );
    }
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
          ...journal,
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
          ...(workspaceCwd !== undefined ? { cwd: workspaceCwd } : {}),
        }),
      );
      if (rolledBack._tag === "Failure") {
        const error = rolledBack.failure;
        // Ryco stopped waiting during the rewind itself: the agent may already
        // have forgotten the turns, so this is never "nothing was changed".
        if (
          error._tag === "ProviderOperationTimeoutError" &&
          error.operation === "conversation.rollback"
        ) {
          return yield* updateRevert({
            threadId,
            revertRequestId,
            turnCount,
            status: "interrupted",
            reason: "provider-failed",
            detail: `${asSentence(error.detail)} The agent may already have forgotten the newer turns, but files and history were not changed. Revert to checkpoint ${turnCount} again to finish.`,
            ...journal,
          });
        }
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
      ...journal,
    });

    // 9. Project the revert and restore files, unless the user keeps them.
    yield* finishRevert({ thread, revertRequestId, turnCount, cwd, keepFiles });
  });

  // An unexpected failure is journaled by how far the revert got: before the
  // provider nothing changed; during it the agent may have forgotten turns;
  // after it the journal stays "restoring-files" so recovery can finish it. A
  // files-only revert has nothing for recovery to finish, so it ends right away.
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
        const scope = revertScope(event.payload);
        const base = { threadId, revertRequestId, turnCount, ...scopeJournal(scope) };
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
            return scope === "files"
              ? logged.pipe(
                  Effect.andThen(
                    updateRevert({
                      ...base,
                      status: "interrupted",
                      reason: "internal-error",
                      detail:
                        "Ryco hit an unexpected error while restoring files. Files may be only partly restored. Review them in Changes or with git before continuing.",
                    }),
                  ),
                )
              : logged;
        }
      }),
    );
  };

  /**
   * Finishes a revert that stopped while restoring files (after the provider rewound,
   * or a files-only one), unless the thread moved on.
   */
  const recoverRestoringFiles = Effect.fn("recoverRestoringFiles")(function* (
    entry: PendingCheckpointRevert,
  ) {
    const { threadId, activity, payload } = entry;
    const turnCount = payload.turnCount;
    const scope = revertScope(payload);
    // A conversation-only revert never touched the files, so neither does its recovery.
    const keepFiles = scope === "conversation";
    const base = {
      threadId,
      revertRequestId: payload.revertRequestId,
      turnCount,
      fromTurnCount: checkpointRevertFromTurnCount(payload),
      cwd: payload.cwd,
      ...scopeJournal(scope),
    };
    const interrupt = (detail: string) =>
      updateRevert({ ...base, status: "interrupted", reason: "restart", detail });
    // The snapshots an earlier attempt left, when they are still there: named whenever
    // recovery leaves the files alone, so they can be recovered by hand.
    const keptRescueRefs = Effect.gen(function* () {
      const cwd = payload.cwd;
      if (keepFiles || cwd === undefined) return [];
      const snapshots = (["revert", "recovery"] as const).map((snapshot) =>
        checkpointRefForThreadRevertRescue(threadId, payload.revertRequestId, snapshot),
      );
      const present = yield* Effect.forEach(snapshots, (checkpointRef) =>
        checkpointStore
          .hasCheckpointRef({ cwd, checkpointRef })
          .pipe(Effect.catch(() => Effect.succeed(false))),
      );
      return snapshots.filter((_, index) => present[index] === true);
    });
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return yield* interrupt(
        keepFiles
          ? "Ryco stopped while reverting and could not finish because this thread is no longer available."
          : `Ryco stopped while restoring files and could not finish because this thread is no longer available.${rescueNote(yield* keptRescueRefs)}`,
      );
    }
    const outcome = revertOutcome(thread, turnCount);
    const fromTurnCount = checkpointRevertFromTurnCount(payload);
    const pendingSinceMs = Date.parse(activity.createdAt);
    const stale =
      !Number.isFinite(pendingSinceMs) ||
      Date.now() - pendingSinceMs >= CHECKPOINT_REVERT_PENDING_STALE_MS;
    if (scope === "files") {
      // Nothing else changed, so the files are restored again only while the thread
      // and the checkout are as the revert left them; otherwise they stay as they are.
      const moved =
        fromTurnCount === undefined ||
        outcome.currentTurnCount !== fromTurnCount ||
        threadChangedSince(thread, activity.createdAt);
      if (moved || stale || payload.cwd === undefined) {
        const why = moved
          ? "this thread changed afterwards"
          : stale
            ? "that was too long ago to finish safely"
            : "Ryco could not find this thread's git workspace";
        return yield* interrupt(
          `Ryco stopped while restoring files from checkpoint ${turnCount} and did not finish, because ${why}. The chat was not changed, but files may be only partly restored. Review them in Changes or with git before continuing.${rescueNote(yield* keptRescueRefs)}`,
        );
      }
      return yield* finishFilesRevert({
        thread,
        revertRequestId: payload.revertRequestId,
        turnCount,
        fromTurnCount,
        cwd: payload.cwd,
        recovering: true,
      });
    }
    if (
      fromTurnCount !== undefined &&
      fromTurnCount > turnCount &&
      outcome.currentTurnCount === turnCount
    ) {
      // thread.reverted was projected; only the final journal update was lost.
      // Keeping the files, that update was all that was left to do.
      return yield* keepFiles
        ? updateRevert({ ...base, status: "completed" })
        : interrupt(
            `The conversation was reverted to checkpoint ${turnCount}, but Ryco stopped before it recorded whether files were restored. Check the files in Changes, or revert to checkpoint ${turnCount} again to restore them.${rescueNote(yield* keptRescueRefs)}`,
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
        keepFiles
          ? `Ryco stopped while reverting, and this thread changed afterwards, so the revert was not finished. Files and the conversation history were not changed, but the agent may already have forgotten the turns after checkpoint ${turnCount}. Review the thread before continuing, or start a new thread.`
          : `Ryco stopped while restoring files, and this thread changed afterwards, so the revert was not finished. The conversation history was not changed, but files may be partly restored and the agent may already have forgotten the turns after checkpoint ${turnCount}. Review the files in Changes and the thread before continuing, or start a new thread.${rescueNote(yield* keptRescueRefs)}`,
      );
    }
    // "restoring-files" is journaled only once the provider rewound (or nothing
    // was dropped), so the revert is always projected from here: retrying it
    // would ask the provider to forget turns it already forgot.
    const cwd =
      payload.cwd ??
      (yield* resolveCheckpointCwd({
        threadId,
        thread,
        projects: yield* resolveThreadProjects(thread.projectId),
        preferSessionRuntime: false,
      }));
    yield* finishRevert({
      thread,
      revertRequestId: payload.revertRequestId,
      turnCount,
      cwd,
      keepFiles,
      recovering: true,
      // Too old to restore files blindly: the checkout may hold newer work.
      skipFiles: stale
        ? {
            reason: "restart",
            text: "Ryco stopped while restoring them too long ago to finish safely",
            partial: true,
            rescueRefs: yield* keptRescueRefs,
          }
        : undefined,
    });
  });

  const recoverEntry = (entry: PendingCheckpointRevert) => {
    const { threadId, payload } = entry;
    const scope = revertScope(payload);
    const keepFiles = scope === "conversation";
    const base = {
      threadId,
      revertRequestId: payload.revertRequestId,
      turnCount: payload.turnCount,
      fromTurnCount: checkpointRevertFromTurnCount(payload),
      cwd: payload.cwd,
      ...scopeJournal(scope),
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
                      detail: keepFiles
                        ? `Ryco stopped while reverting and could not finish after restarting. The agent may already have forgotten the turns after checkpoint ${payload.turnCount}. Revert to checkpoint ${payload.turnCount} again to finish.`
                        : scope === "files"
                          ? "Ryco stopped while restoring files and could not finish after restarting. The chat was not changed, but files may be only partly restored. Review them in Changes or with git before continuing."
                          : `Ryco stopped while restoring files and could not finish after restarting. Files may be partly restored, and the agent may already have forgotten the turns after checkpoint ${payload.turnCount}. Review the files in Changes, then revert to checkpoint ${payload.turnCount} again to finish.`,
                    }),
                  ),
                ),
          ),
        );
      default:
        return Effect.void;
    }
  };

  return {
    handleRevertRequested: handleRevertRequestedSafely,
    recover: (pending) => Effect.forEach(pending, recoverEntry, { discard: true }),
  };
}
