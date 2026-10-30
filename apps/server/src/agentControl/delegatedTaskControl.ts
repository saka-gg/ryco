/**
 * Status, acknowledgement and cancel for tasks a chat delegated with `ryco_create_threads`
 * `returnToOrigin` (delegation-returns §4.8). Stateless: every decision is a ledger read or a
 * revision CAS, so it is safe beside the delivery worker and needs no second scan loop.
 *
 * Ownership is the ledger row's parent **thread**, not the runtime session, so the tools keep
 * working after a restart.
 */
import {
  AGENT_CONTROL_TASK_NOTICE_MAX_CHARS,
  AGENT_CONTROL_TASK_RESULT_MAX_CHARS,
  AGENT_CONTROL_TASK_STATUS_MAX_TASKS,
  AgentControlTaskNoticeOutcome,
  type AgentControlTaskRunState,
  type AgentControlTaskStatusEntry,
  type AgentControlTaskStatusResult,
  type OrchestrationThreadShell,
  type ThreadId,
  type TurnId,
} from "@ryco/contracts";
import { redactDiagnosticText } from "@ryco/shared/diagnosticRedaction";
import { Effect, Option, Schema } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";
import {
  DELEGATION_WAKE_MESSAGE_PREFIX,
  type CompletionReturnRecord,
  type CompletionReturnRepository,
} from "../persistence/Layers/AgentControlCompletionReturns.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { readDelegatedRunState } from "../persistence/delegatedRunStatus.ts";
import type { AgentControlProposalRepositoryShape } from "../persistence/Services/AgentControlProposals.ts";
import {
  cancelledTaskEntryIds,
  delegationSlotCancelCommandId,
  noUserMessageSent,
  waitsForDelegationSlot,
} from "../orchestration/delegationSlotHold.ts";
import { findThreadInArray } from "../orchestration/threadIndex.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { publishCompletionReturns } from "./completionReturnPublish.ts";
import { redactAgentControlSecrets } from "./ProviderInjection.ts";
import type { AgentControlProposalEventsShape } from "./Services/AgentControlProposalEvents.ts";
import { loadMessagePages, MESSAGE_PAGE_LIMITS } from "./Mcp/threadReads.ts";

export class DelegatedTaskNotOwned {
  readonly _tag = "DelegatedTaskNotOwned";
}

/** A result continuation named a version or offset the task's result no longer has. */
export class DelegatedTaskResultChanged {
  readonly _tag = "DelegatedTaskResultChanged";
}

export const DELEGATED_TASK_ACK_DETAIL =
  "Read by the originating chat with ryco_task_status; no automatic message needed.";
const ackDetail = (record: CompletionReturnRecord) =>
  record.capture?.kind === "notice"
    ? `Notice (${record.capture.outcome}) read by the originating chat with ryco_task_status; no automatic message needed.`
    : DELEGATED_TASK_ACK_DETAIL;
const isNoticeOutcome = Schema.is(AgentControlTaskNoticeOutcome);
export const DELEGATED_TASK_CANCEL_DETAIL =
  "Cancelled by the delegating chat with ryco_task_cancel. No result will be returned automatically.";
/** The return was cancelled with `ryco_task_cancel` (not by the chat's Stop, archive or delete). */
export const cancelledByDelegatingChat = (
  record: Pick<CompletionReturnRecord, "status" | "detail">,
) => record.status === "cancelled" && record.detail === DELEGATED_TASK_CANCEL_DETAIL;
/**
 * The delegating chat no longer waits for the task's return: cancelled with `ryco_task_cancel`,
 * by the chat's Stop, archive or delete, past its time limit, or settled otherwise. A task in this
 * state whose first message was never sent (a capped request's task waiting for a slot) never
 * starts.
 */
export const noLongerAwaited = (record: Pick<CompletionReturnRecord, "status">) =>
  record.status !== "waiting";
export const DELEGATED_TASK_WAITING_DETAIL =
  "Waiting for a free slot: it starts when an earlier task of its request stops working.";

export interface DelegatedTaskControlDeps {
  readonly repository: Pick<
    typeof CompletionReturnRepository.Service,
    | "get"
    | "save"
    | "listForParent"
    | "listForProposal"
    | "cancelOwned"
    | "initialTurnId"
    | "turnInfo"
    | "output"
  >;
  readonly proposals: Pick<AgentControlProposalRepositoryShape, "getById">;
  readonly events: Pick<AgentControlProposalEventsShape, "publish">;
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getThreadMessageById"
  >;
  readonly sql: SqlClient.SqlClient;
  /**
   * Takes a cancelled task's unsent first message out of its queue, reading the queue from the
   * engine's model; without both, nothing is.
   */
  readonly engine?: Pick<OrchestrationEngineShape, "dispatch" | "getReadModel">;
}

/** Redacts a whole text; slicing happens after, so a cut never splits a secret. */
const redact = (text: string) => redactDiagnosticText(String(redactAgentControlSecrets(text)));

/** Where a result read starts: its version and offset. */
interface ResultContinuation {
  readonly version: string;
  readonly offsetChars: number;
}

export const makeDelegatedTaskControl = (deps: DelegatedTaskControlDeps) => {
  const publish = (record: CompletionReturnRecord) =>
    publishCompletionReturns(
      { repository: deps.repository, proposals: deps.proposals, events: deps.events },
      record.proposalId,
    );

  const runState = (record: CompletionReturnRecord) =>
    readDelegatedRunState(deps.sql, {
      threadId: record.childThreadId,
      messageId: record.initialMessageId,
    }).pipe(
      Effect.mapError(toPersistenceSqlError("DelegatedTaskControl.runState")),
      Effect.map((state): AgentControlTaskRunState => (state === "rejected" ? "failed" : state)),
    );

  /** The child moved on: its latest turn is not the initial, settled or a wake turn. */
  const advanced = (record: CompletionReturnRecord, child: OrchestrationThreadShell | null) =>
    Effect.gen(function* () {
      const latestTurnId = child?.latestTurn?.turnId;
      if (!latestTurnId || latestTurnId === record.settled?.turnId) return false;
      if (latestTurnId === (yield* deps.repository.initialTurnId(record))) return false;
      const turn = yield* deps.repository.turnInfo(record.childThreadId, latestTurnId);
      return !(turn?.pendingMessageId?.startsWith(DELEGATION_WAKE_MESSAGE_PREFIX) ?? false);
    });

  /**
   * The child's result as one page. With `whole` (a read of one task) the reply message
   * is read whole, so it can be paged; a list shows only its start.
   */
  const resultPage = (
    record: CompletionReturnRecord,
    settled: { readonly turnId: TurnId; readonly state: "completed" | "error" },
    whole: boolean,
    continuation: ResultContinuation | undefined,
  ) =>
    Effect.gen(function* () {
      const output = yield* deps.repository.output(record.childThreadId, settled.turnId);
      const message =
        whole && output.messageId !== null && deps.projections.getThreadMessageById !== undefined
          ? Option.getOrNull(
              yield* deps.projections.getThreadMessageById({
                threadId: record.childThreadId,
                messageId: output.messageId,
              }),
            )
          : null;
      const page = (yield* loadMessagePages).pageTaskResult({
        state: settled.state,
        text: output.text,
        whole: message,
        redact,
        continuation,
        limits: MESSAGE_PAGE_LIMITS,
      });
      if (page === null) return yield* Effect.fail(new DelegatedTaskResultChanged());
      return page;
    });

  const describe = (
    record: CompletionReturnRecord,
    acknowledged: boolean,
    read: { readonly whole: boolean; readonly continuation?: ResultContinuation | undefined },
  ) =>
    Effect.gen(function* () {
      const shell = yield* deps.projections.getThreadShellById(record.childThreadId);
      const child = Option.getOrNull(shell);
      const settled = record.settled;
      const result =
        settled && (settled.state === "completed" || settled.state === "error")
          ? yield* resultPage(
              record,
              { turnId: settled.turnId, state: settled.state },
              read.whole,
              read.continuation,
            )
          : null;
      if (read.continuation !== undefined && result === null) {
        return yield* Effect.fail(new DelegatedTaskResultChanged());
      }
      // The server-authored notice a wake would carry (no child text). It stays on the row,
      // so an acknowledged notice remains readable.
      const capture = record.capture;
      const notice =
        capture?.kind === "notice" && isNoticeOutcome(capture.outcome)
          ? {
              outcome: capture.outcome,
              text: capture.section.slice(0, AGENT_CONTROL_TASK_NOTICE_MAX_CHARS),
            }
          : null;
      let state = yield* runState(record);
      // Its first message was never sent: a task of a capped request still waiting for a slot,
      // or one its chat gave up on before that (it never starts).
      const unsent = state === "starting" && child !== null && child.latestUserMessageAt === null;
      const cancelled = unsent && noLongerAwaited(record);
      const waiting =
        unsent &&
        !cancelled &&
        waitsForDelegationSlot(child.followUpQueueSummary?.hold, record.proposalId);
      if (cancelled) state = "interrupted";
      if (waiting) state = "waiting";
      return {
        taskId: record.childThreadId,
        proposalId: record.proposalId,
        title: child ? redact(child.title).slice(0, AGENT_CONTROL_TASK_RESULT_MAX_CHARS) : null,
        return: { status: record.status, detail: record.detail, updatedAt: record.updatedAt },
        run: {
          state,
          ...(waiting ? { detail: DELEGATED_TASK_WAITING_DETAIL } : {}),
          sessionStatus: child?.session?.status ?? null,
          hasPendingApprovals: child?.hasPendingApprovals ?? false,
          // Questions are reported only as a flag; their text never crosses this boundary.
          hasPendingUserInput: child?.hasPendingUserInput ?? false,
          backgroundLiveness: child?.backgroundLiveness ?? null,
          advanced: yield* advanced(record, child),
        },
        result,
        notice,
        acknowledged,
      } satisfies AgentControlTaskStatusEntry;
    });

  /**
   * A finished task read by id during the caller's own exact turn needs no separate wake: its
   * `ready` row becomes `delivered`. The status entry carries the same result or notice the
   * wake would have, so nothing is lost. A lost race with the delivery claim just reports it.
   */
  const acknowledge = (record: CompletionReturnRecord, now: string) =>
    Effect.gen(function* () {
      if (record.status !== "ready") return { record, acknowledged: false };
      const next: CompletionReturnRecord = {
        ...record,
        status: "delivered",
        detail: ackDetail(record),
        updatedAt: now,
        nextCheckAt: now,
      };
      if (!(yield* deps.repository.save(record, next))) {
        const current = yield* deps.repository.get(record.childThreadId);
        return { record: current ?? record, acknowledged: false };
      }
      yield* publish(next);
      return { record: { ...next, revision: record.revision + 1 }, acknowledged: true };
    });

  const status = (input: {
    readonly callerThreadId: ThreadId;
    readonly taskId?: ThreadId | undefined;
    /** Read on in the task's result; requires `taskId`. */
    readonly result?: ResultContinuation | undefined;
    /** The caller holds exact active-turn authority for its own thread. */
    readonly exactTurn: boolean;
    readonly now: string;
  }) =>
    Effect.gen(function* () {
      // Only a read of one task acknowledges it. A list can exceed what a provider shows of
      // one tool result, so marking every listed row read could drop content unseen; its
      // tasks still arrive in a wake.
      const acknowledges = input.exactTurn && input.taskId !== undefined;
      if (input.result !== undefined && input.taskId === undefined) {
        return yield* Effect.fail(new DelegatedTaskResultChanged());
      }
      let rows: ReadonlyArray<CompletionReturnRecord>;
      if (input.taskId !== undefined) {
        const row = yield* deps.repository.get(input.taskId);
        if (!row || row.parentThreadId !== input.callerThreadId)
          return yield* Effect.fail(new DelegatedTaskNotOwned());
        rows = [row];
      } else {
        rows = yield* deps.repository.listForParent(
          input.callerThreadId,
          AGENT_CONTROL_TASK_STATUS_MAX_TASKS,
        );
      }
      const tasks: AgentControlTaskStatusEntry[] = [];
      for (const row of rows) {
        const acked = acknowledges
          ? yield* acknowledge(row, input.now)
          : { record: row, acknowledged: false };
        tasks.push(
          yield* describe(acked.record, acked.acknowledged, {
            whole: input.taskId !== undefined,
            continuation: input.result,
          }),
        );
      }
      return {
        tasks,
        truncated: input.taskId === undefined && rows.length >= AGENT_CONTROL_TASK_STATUS_MAX_TASKS,
      } satisfies AgentControlTaskStatusResult;
    });

  /**
   * Stop the automatic return before anything interrupts the child, so the interrupt's
   * settlement cannot turn into a notice.
   */
  /** The task's thread as the engine holds it now. */
  const engineThread = (threadId: ThreadId) =>
    deps.engine?.getReadModel === undefined
      ? Effect.succeed(undefined)
      : deps.engine
          .getReadModel()
          .pipe(Effect.map((model) => findThreadInArray(model.threads, threadId)));

  /**
   * A task whose first message waits in its queue (a capped request's task waiting for a slot,
   * or released and not sent yet) never starts: that message and the agent's own follow-ups
   * leave the queue, under one id per task. True only when the first message is out of the queue
   * and was never sent: the drain may have sent it between the read and the removal.
   */
  const stopUnsent = (record: CompletionReturnRecord, now: string) =>
    Effect.gen(function* () {
      const before = yield* engineThread(record.childThreadId);
      const queued = before?.followUpQueue?.entries ?? [];
      if (
        deps.engine === undefined ||
        before === undefined ||
        !noUserMessageSent(before) ||
        !queued.some((entry) => entry.messageId === record.initialMessageId)
      ) {
        return false;
      }
      yield* Effect.exit(
        deps.engine.dispatch({
          type: "thread.queue.remove",
          commandId: delegationSlotCancelCommandId(record.proposalId, record.childThreadId),
          threadId: record.childThreadId,
          messageIds: cancelledTaskEntryIds(queued, record.initialMessageId),
          createdAt: now,
        }),
      );
      const after = yield* engineThread(record.childThreadId);
      return (
        after !== undefined &&
        noUserMessageSent(after) &&
        !(after.followUpQueue?.entries ?? []).some(
          (entry) => entry.messageId === record.initialMessageId,
        )
      );
    });

  const cancel = (input: {
    readonly callerThreadId: ThreadId;
    readonly taskId: ThreadId;
    readonly now: string;
  }) =>
    Effect.gen(function* () {
      const record = yield* deps.repository.cancelOwned({
        childThreadId: input.taskId,
        parentThreadId: input.callerThreadId,
        detail: DELEGATED_TASK_CANCEL_DETAIL,
        now: input.now,
      });
      if (!record) return yield* Effect.fail(new DelegatedTaskNotOwned());
      if (cancelledByDelegatingChat(record)) yield* publish(record);
      const stoppedBeforeStart = cancelledByDelegatingChat(record)
        ? yield* stopUnsent(record, input.now)
        : false;
      // Read after the removal: a task the drain started meanwhile shows its turn.
      const child = Option.getOrNull(yield* deps.projections.getThreadShellById(input.taskId));
      return { record, child, stoppedBeforeStart };
    });

  return { status, cancel };
};

export type DelegatedTaskControl = ReturnType<typeof makeDelegatedTaskControl>;
