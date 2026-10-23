import type {
  ClientOrchestrationCommand,
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationThreadActivity,
  ServerConfig,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { CHECKPOINT_REVERT_ACTIVITY_KIND } from "@ryco/contracts/orchestration";
import { latestCheckpointRevertActivity } from "@ryco/shared/threadActivity";

import { isDefiniteDispatchFailure } from "../../rpc/protocol.ts";
import { scopedThreadKey, scopeThreadRef } from "../../scoped.ts";
import type { TurnDiffSummary } from "../threads/types.ts";

// The client half of a checkpoint revert, shared by web, desktop and mobile:
// the guards that refuse before anything is asked, the command each choice
// sends, the wait for the node's verdict, and which threads have one running.

/**
 * What a revert does to the checkout. Both make the agent forget the newer
 * turns and drop them from the thread. "keep-files" (`thread.conversation.revert`)
 * leaves the files as they are; "restore-files" (`thread.checkpoint.revert`)
 * puts them back to the checkpoint, when no other thread in the checkout would
 * lose work.
 */
export type CheckpointRevertMode = "keep-files" | "restore-files";

/** "Edit from here" wording, shared so web, desktop and mobile say the same. */
export const EDIT_FROM_HERE_COPY = {
  action: "Edit from here",
  title: "Edit from here?",
  description:
    "The agent forgets this message and everything after it. Your prompt and its attachments return to the composer.",
  restoreFilesNote:
    "Revert files too also puts the files in this checkout back to how they were before this message, including your own edits since then.",
  restoreOnlyNote:
    "The files in this checkout go back to how they were before this message. Changes since then, including your own edits, are discarded.",
  keepFiles: "Revert and keep changes",
  restoreFiles: "Revert files too",
  /** The only choice on a machine without `thread.conversation.revert`. */
  restoreOnly: "Revert files",
} as const;

/** Said when restoring files would also discard changes an earlier revert left in place. */
export function keptChangesRestoreNote(turnCount: number): string {
  return `Restoring the files also discards the changes kept when this thread was reverted to checkpoint ${turnCount}.`;
}

/** Ryco could not tell whether the node reverted; whatever was prepared is returned anyway. */
export const CHECKPOINT_REVERT_UNCONFIRMED_MESSAGE =
  "Ryco couldn't confirm that the revert finished. Check the thread before you continue.";

export function checkpointRevertCommand(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly mode: CheckpointRevertMode;
  readonly createdAt: string;
}): Extract<
  ClientOrchestrationCommand,
  { type: "thread.checkpoint.revert" | "thread.conversation.revert" }
> {
  return {
    type: input.mode === "keep-files" ? "thread.conversation.revert" : "thread.checkpoint.revert",
    commandId: input.commandId,
    threadId: input.threadId,
    turnCount: input.turnCount,
    createdAt: input.createdAt,
  };
}

export type RevertThreadCheckpointGuardFailure =
  | { readonly type: "missing-api" }
  /** This client already has a revert of the thread open or running. */
  | { readonly type: "already-reverting" }
  | { readonly type: "environment-unavailable"; readonly label: string }
  | { readonly type: "turn-in-progress" }
  | { readonly type: "provider-unsupported"; readonly message: string }
  | { readonly type: "user-cancelled" };

export function revertCheckpointGuardFailureMessage(
  failure: RevertThreadCheckpointGuardFailure,
): string | null {
  switch (failure.type) {
    case "missing-api":
    case "already-reverting":
    case "user-cancelled":
      return null;
    case "environment-unavailable":
      return `Reconnect ${failure.label} before reverting checkpoints.`;
    case "turn-in-progress":
      return "Interrupt the current turn before reverting checkpoints.";
    case "provider-unsupported":
      return failure.message;
  }
}

// ---------------------------------------------------------------------------
// Reverts in flight
// ---------------------------------------------------------------------------

/** "choosing" from the question on, "reverting" from the user's choice until the verdict. */
export type CheckpointRevertPhase = "choosing" | "reverting";

// This client's reverts, by scoped thread key. Views read it (`useSyncExternalStore`
// over `subscribeCheckpointReverts` and `readCheckpointRevertPhase`) instead of holding
// their own flag, so a revert stays visible across thread switches and remounts, and one
// thread's revert never ends another's. Only `runCheckpointRevert` writes it. A plain
// store, not zustand: the server's boot graph imports this module.
const revertPhaseByThreadKey = new Map<string, CheckpointRevertPhase>();
const revertPhaseListeners = new Set<() => void>();

function setCheckpointRevertPhase(threadKey: string, phase: CheckpointRevertPhase | null): void {
  if ((revertPhaseByThreadKey.get(threadKey) ?? null) === phase) return;
  if (phase === null) revertPhaseByThreadKey.delete(threadKey);
  else revertPhaseByThreadKey.set(threadKey, phase);
  for (const listener of revertPhaseListeners) listener();
}

/** The revert phase of one thread, or null when this client runs none. */
export function readCheckpointRevertPhase(threadKey: string | null): CheckpointRevertPhase | null {
  return threadKey === null ? null : (revertPhaseByThreadKey.get(threadKey) ?? null);
}

/** Calls `listener` whenever a thread's revert phase changes. */
export function subscribeCheckpointReverts(listener: () => void): () => void {
  revertPhaseListeners.add(listener);
  return () => {
    revertPhaseListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// The node's verdict
// ---------------------------------------------------------------------------

/** What this client holds of the thread a revert runs in. */
export interface CheckpointRevertThreadView {
  readonly latestTurn: { readonly turnId: TurnId } | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly messages: ReadonlyArray<{ readonly turnId?: TurnId | null | undefined }>;
  readonly turnDiffSummaries: ReadonlyArray<{ readonly turnId: TurnId }>;
}

/** What the node said about a revert that rewound the thread, worth showing. */
export interface CheckpointRevertNotice {
  readonly tone: "info" | "warning";
  readonly title: string;
  readonly detail: string;
}

/** The node's verdict on one revert. */
export type CheckpointRevertOutcome =
  /** The thread and the agent's history were rewound. */
  | { readonly kind: "reverted"; readonly notice: CheckpointRevertNotice | null }
  /** Nothing was rewound; `detail` says why. */
  | { readonly kind: "not-reverted"; readonly detail: string }
  /** No verdict in time. */
  | { readonly kind: "unknown" };

/** The server journals every phase of a revert in this one activity row. */
export function checkpointRevertJournalId(commandId: CommandId | string): string {
  return `checkpoint-revert:${commandId}`;
}

/** What nodes before the journal (v0.1.30 and older) appended when a revert failed. */
const LEGACY_REVERT_FAILED_ACTIVITY_KIND = "checkpoint.revert.failed";

interface RevertRowPayload {
  readonly status?: unknown;
  readonly detail?: unknown;
  readonly turnCount?: unknown;
  readonly restoreFiles?: unknown;
}

function rowPayload(activity: OrchestrationThreadActivity): RevertRowPayload {
  return activity.payload !== null && typeof activity.payload === "object"
    ? (activity.payload as RevertRowPayload)
    : {};
}

function rowDetail(activity: OrchestrationThreadActivity): string | null {
  const detail = rowPayload(activity).detail;
  return typeof detail === "string" && detail.trim().length > 0 ? detail : null;
}

/**
 * The verdict a revert's journal row gives, or null while it runs. A row that
 * ended without changing anything still counts as reverted once the thread was
 * seen rewound (a restart lost only its last update).
 */
function verdictFromRow(
  row: OrchestrationThreadActivity,
  rewound: boolean,
): Exclude<CheckpointRevertOutcome, { kind: "unknown" }> | null {
  const detail = rowDetail(row);
  switch (rowPayload(row).status) {
    case "completed":
      return {
        kind: "reverted",
        notice: detail === null ? null : { tone: "info", title: row.summary, detail },
      };
    case "files-not-restored":
      return {
        kind: "reverted",
        notice: { tone: "warning", title: row.summary, detail: detail ?? row.summary },
      };
    case "failed":
    case "interrupted":
      return rewound
        ? {
            kind: "reverted",
            notice: { tone: "warning", title: row.summary, detail: detail ?? row.summary },
          }
        : { kind: "not-reverted", detail: detail ?? row.summary };
    // Pending, or a status this client does not know yet.
    default:
      return null;
  }
}

/** What the thread looked like when the revert was sent. */
interface RevertBaseline {
  readonly latestTurnId: TurnId | null;
  /** Turns the thread held then, other than the latest: where a rewind leaves it. */
  readonly earlierTurnIds: ReadonlySet<TurnId>;
  readonly legacyFailureIds: ReadonlySet<string>;
}

function captureRevertBaseline(
  thread: CheckpointRevertThreadView | undefined,
): RevertBaseline | null {
  if (thread === undefined || thread.latestTurn === null) return null;
  const latestTurnId = thread.latestTurn.turnId;
  const earlierTurnIds = new Set<TurnId>();
  for (const entry of [...thread.messages, ...thread.turnDiffSummaries]) {
    if (entry.turnId && entry.turnId !== latestTurnId) earlierTurnIds.add(entry.turnId);
  }
  return {
    latestTurnId,
    earlierTurnIds,
    legacyFailureIds: new Set(
      thread.activities
        .filter((activity) => activity.kind === LEGACY_REVERT_FAILED_ACTIVITY_KIND)
        .map((activity) => activity.id),
    ),
  };
}

/**
 * Whether the thread was rewound: its latest turn moved back to one it held
 * before, or to none. Read from the shell, which a body eviction or a reload of
 * the message window never drops, and which every node version updates.
 */
function isRewound(baseline: RevertBaseline, thread: CheckpointRevertThreadView): boolean {
  const current = thread.latestTurn?.turnId ?? null;
  return (
    current !== baseline.latestTurnId && (current === null || baseline.earlierTurnIds.has(current))
  );
}

/** Matches the server's backstop, after which a pending revert no longer blocks the thread. */
export const CHECKPOINT_REVERT_OUTCOME_TIMEOUT_MS = 10 * 60_000;
/**
 * How long a revert whose send was cut off is watched for a sign the node took
 * it, before it counts as unconfirmed. Once its journal row shows up, the
 * revert gets the full `CHECKPOINT_REVERT_OUTCOME_TIMEOUT_MS`.
 */
export const CHECKPOINT_REVERT_UNCONFIRMED_TIMEOUT_MS = 60_000;

/**
 * Resolves once the revert sent as `commandId` reaches a verdict: its journal
 * row's final phase, or, from a node that keeps no journal, the thread seen
 * rewound or that node's failure row. Rescans only when the thread changes.
 */
export function waitForCheckpointRevertOutcome(input: {
  readonly commandId: CommandId;
  readonly turnCount: number;
  /** The thread as it was when the revert was sent. */
  readonly before: CheckpointRevertThreadView | undefined;
  /** The thread as this client holds it now; undefined when not loaded. */
  readonly readThread: () => CheckpointRevertThreadView | undefined;
  readonly subscribe: (listener: () => void) => () => void;
  readonly timeoutMs?: number | undefined;
  /**
   * For a send that was cut off: how long to wait for the revert's journal row
   * before giving up. Once the row is seen, `timeoutMs` applies, counted from
   * the start of the wait.
   */
  readonly unconfirmedTimeoutMs?: number | undefined;
}): Promise<CheckpointRevertOutcome> {
  const journalId = checkpointRevertJournalId(input.commandId);
  const baseline = captureRevertBaseline(input.before);
  const timeoutMs = input.timeoutMs ?? CHECKPOINT_REVERT_OUTCOME_TIMEOUT_MS;
  const waitStartedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let rewound = false;
    let lastActivities: ReadonlyArray<OrchestrationThreadActivity> | undefined;
    let lastLatestTurn: CheckpointRevertThreadView["latestTurn"] | undefined;
    let unsubscribe: () => void = () => {};
    let awaitingRow =
      input.unconfirmedTimeoutMs !== undefined && input.unconfirmedTimeoutMs < timeoutMs;
    let timeout = setTimeout(
      () => onTimeout(),
      awaitingRow ? (input.unconfirmedTimeoutMs ?? timeoutMs) : timeoutMs,
    );
    const finish = (outcome: CheckpointRevertOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve(outcome);
    };
    const onTimeout = () =>
      finish(rewound ? { kind: "reverted", notice: null } : { kind: "unknown" });
    const inspect = () => {
      const thread = input.readThread();
      if (thread === undefined) return;
      if (thread.activities === lastActivities && thread.latestTurn === lastLatestTurn) return;
      lastActivities = thread.activities;
      lastLatestTurn = thread.latestTurn;
      rewound ||= baseline !== null && isRewound(baseline, thread);
      const row = thread.activities.findLast(
        (activity) =>
          activity.id === journalId && activity.kind === CHECKPOINT_REVERT_ACTIVITY_KIND,
      );
      if (row !== undefined) {
        if (awaitingRow) {
          // The node took the revert after all: give it the full time to finish.
          awaitingRow = false;
          clearTimeout(timeout);
          timeout = setTimeout(onTimeout, Math.max(0, timeoutMs - (Date.now() - waitStartedAt)));
        }
        // A journaling node: its row's final phase follows the rewind right away.
        const verdict = verdictFromRow(row, rewound);
        if (verdict !== null) finish(verdict);
        return;
      }
      if (baseline !== null) {
        const legacyFailure = thread.activities.find(
          (activity) =>
            activity.kind === LEGACY_REVERT_FAILED_ACTIVITY_KIND &&
            !baseline.legacyFailureIds.has(activity.id) &&
            rowPayload(activity).turnCount === input.turnCount,
        );
        if (legacyFailure !== undefined && !rewound) {
          finish({
            kind: "not-reverted",
            detail: rowDetail(legacyFailure) ?? legacyFailure.summary,
          });
          return;
        }
      }
      if (rewound) finish({ kind: "reverted", notice: null });
    };
    unsubscribe = input.subscribe(inspect);
    // The verdict may already be here.
    inspect();
  });
}

// ---------------------------------------------------------------------------
// One revert, end to end
// ---------------------------------------------------------------------------

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export type CheckpointRevertResult<TPrepared> =
  /** Refused before anything was sent; `revertCheckpointGuardFailureMessage` says why. */
  | { readonly kind: "refused"; readonly reason: RevertThreadCheckpointGuardFailure }
  /** The node rewound the thread: `prepared` goes back, `notice` is worth showing. */
  | {
      readonly kind: "reverted";
      readonly mode: CheckpointRevertMode;
      readonly prepared: TPrepared;
      readonly notice: CheckpointRevertNotice | null;
    }
  /** Nothing was rewound: preparing failed, or the node refused. */
  | { readonly kind: "not-reverted"; readonly error: string }
  /**
   * No verdict: the send was cut off or the node never answered. `prepared`
   * comes back anyway, because the node may have deleted what it holds.
   */
  | {
      readonly kind: "unconfirmed";
      readonly mode: CheckpointRevertMode;
      readonly prepared: TPrepared;
      readonly error: string;
    };

/**
 * One checkpoint revert. Refuses what cannot work before asking anything (a
 * revert of this thread already runs here, the machine is away, a turn is
 * running, the provider cannot forget turns), asks how to revert, prepares,
 * sends the command, and waits for the node's verdict. `prepare` runs after the
 * choice and before the command: whatever it throws reverts nothing.
 */
export async function runCheckpointRevert<TPrepared = undefined>(input: {
  readonly environmentId: EnvironmentId;
  readonly dispatchCommand: ((command: ClientOrchestrationCommand) => Promise<unknown>) | null;
  readonly threadId: ThreadId | null;
  readonly turnCount: number;
  readonly environmentUnavailable: boolean;
  readonly environmentUnavailableLabel: string | null;
  readonly turnInProgress: boolean;
  /** Why the thread's provider cannot forget turns (`checkpointRevertUnsupportedMessage`). */
  readonly providerRefusal: string | null;
  /** Asks the user how to revert; null cancels. */
  readonly choose: () => Promise<CheckpointRevertMode | null>;
  readonly prepare?: ((mode: CheckpointRevertMode) => Promise<TPrepared>) | undefined;
  readonly newCommandId: () => CommandId;
  readonly now?: () => string;
  /** The thread as this client holds it; undefined when not loaded. */
  readonly readThread: () => CheckpointRevertThreadView | undefined;
  /** Calls `listener` whenever the threads this client holds change. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly timeoutMs?: number | undefined;
  readonly unconfirmedTimeoutMs?: number | undefined;
}): Promise<CheckpointRevertResult<TPrepared>> {
  const { threadId } = input;
  if (!input.dispatchCommand || !threadId) {
    return { kind: "refused", reason: { type: "missing-api" } };
  }
  const threadKey = scopedThreadKey(scopeThreadRef(input.environmentId, threadId));
  if (readCheckpointRevertPhase(threadKey) !== null) {
    return { kind: "refused", reason: { type: "already-reverting" } };
  }
  if (input.environmentUnavailable) {
    return {
      kind: "refused",
      reason: {
        type: "environment-unavailable",
        label: input.environmentUnavailableLabel ?? "environment",
      },
    };
  }
  if (input.turnInProgress) {
    return { kind: "refused", reason: { type: "turn-in-progress" } };
  }
  // Refuse before the user chooses anything the provider cannot do.
  if (input.providerRefusal !== null) {
    return {
      kind: "refused",
      reason: { type: "provider-unsupported", message: input.providerRefusal },
    };
  }

  setCheckpointRevertPhase(threadKey, "choosing");
  try {
    let mode: CheckpointRevertMode | null;
    try {
      mode = await input.choose();
    } catch (error) {
      return { kind: "not-reverted", error: errorMessage(error, "Failed to revert thread state.") };
    }
    if (mode === null) {
      return { kind: "refused", reason: { type: "user-cancelled" } };
    }
    setCheckpointRevertPhase(threadKey, "reverting");
    let prepared: TPrepared;
    try {
      prepared = (await input.prepare?.(mode)) as TPrepared;
    } catch (error) {
      return { kind: "not-reverted", error: errorMessage(error, "Failed to revert thread state.") };
    }

    const commandId = input.newCommandId();
    const before = input.readThread();
    let dispatchCutOff = false;
    try {
      await input.dispatchCommand(
        checkpointRevertCommand({
          commandId,
          threadId,
          turnCount: input.turnCount,
          mode,
          createdAt: input.now?.() ?? new Date().toISOString(),
        }),
      );
    } catch (error) {
      if (isDefiniteDispatchFailure(error)) {
        return {
          kind: "not-reverted",
          error: errorMessage(error, "Failed to revert thread state."),
        };
      }
      // The node may have taken it before the connection dropped: watch a while.
      // Anything but a definite answer counts here, since the revert deletes the
      // message: returning the prompt needlessly beats losing it.
      dispatchCutOff = true;
    }

    const outcome = await waitForCheckpointRevertOutcome({
      commandId,
      turnCount: input.turnCount,
      before,
      readThread: input.readThread,
      subscribe: input.subscribe,
      timeoutMs: input.timeoutMs,
      unconfirmedTimeoutMs: dispatchCutOff
        ? (input.unconfirmedTimeoutMs ?? CHECKPOINT_REVERT_UNCONFIRMED_TIMEOUT_MS)
        : undefined,
    });
    switch (outcome.kind) {
      case "reverted":
        return { kind: "reverted", mode, prepared, notice: outcome.notice };
      case "not-reverted":
        return { kind: "not-reverted", error: outcome.detail };
      case "unknown":
        return {
          kind: "unconfirmed",
          mode,
          prepared,
          error: CHECKPOINT_REVERT_UNCONFIRMED_MESSAGE,
        };
    }
  } finally {
    setCheckpointRevertPhase(threadKey, null);
  }
}

/** The machine takes `thread.conversation.revert`; an older one only restores files. */
export function selectConversationRevertSupported(config: ServerConfig | null): boolean {
  return config?.environment.capabilities.conversationRevert === true;
}

/**
 * The checkpoint a finished revert left the dropped turns' changes in place
 * at (kept on purpose, or not restored), when restoring checkpoint `turnCount`
 * would discard them too; null otherwise. The next turn's changes start from
 * that checkpoint, so an Undo of it takes them along. A later revert that
 * failed changed nothing, so it is passed over, as the node's own check does.
 */
export function revertKeptChangesDiscardedBy(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnCount: number,
): number | null {
  const latest = latestCheckpointRevertActivity(activities, { skipFailed: true });
  if (latest === null) return null;
  const payload = rowPayload(latest);
  const leftChanges =
    (payload.status === "completed" && payload.restoreFiles === false) ||
    payload.status === "files-not-restored";
  return leftChanges && typeof payload.turnCount === "number" && payload.turnCount >= turnCount
    ? payload.turnCount
    : null;
}

/**
 * The checkpoint "Edit from here" on each sent message reverts to: the one before
 * the turn its reply finished. `messages` run in timeline order; a prompt whose
 * reply has no checkpoint gets none.
 */
export function deriveRevertTurnCountByUserMessageId(input: {
  readonly messages: Iterable<{ readonly id: MessageId; readonly role: string }>;
  readonly turnDiffSummaryByAssistantMessageId: ReadonlyMap<
    MessageId,
    Pick<TurnDiffSummary, "turnId" | "checkpointTurnCount">
  >;
  readonly inferredCheckpointTurnCountByTurnId: Readonly<Partial<Record<TurnId, number>>>;
}): Map<MessageId, number> {
  const byUserMessageId = new Map<MessageId, number>();
  let pendingUserMessageId: MessageId | null = null;
  for (const message of input.messages) {
    if (message.role === "user") {
      pendingUserMessageId = message.id;
      continue;
    }
    if (!pendingUserMessageId) continue;
    const summary = input.turnDiffSummaryByAssistantMessageId.get(message.id);
    if (!summary) continue;
    const turnCount =
      summary.checkpointTurnCount ?? input.inferredCheckpointTurnCountByTurnId[summary.turnId];
    if (typeof turnCount === "number") {
      byUserMessageId.set(pendingUserMessageId, Math.max(0, turnCount - 1));
    }
    pendingUserMessageId = null;
  }
  return byUserMessageId;
}
