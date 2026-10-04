/**
 * Status, acknowledgement and cancel for tasks a chat delegated with `ryco_create_threads`
 * `returnToOrigin` (delegation-returns §4.8). Stateless: every decision is a ledger read or a
 * revision CAS, so it is safe beside the delivery worker and needs no second scan loop.
 *
 * Ownership is the ledger row's parent **thread**, not the runtime session, so the tools keep
 * working after a restart.
 */
import {
  AGENT_CONTROL_TASK_RESULT_MAX_CHARS,
  AGENT_CONTROL_TASK_STATUS_MAX_TASKS,
  type AgentControlTaskRunState,
  type AgentControlTaskStatusEntry,
  type AgentControlTaskStatusResult,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@ryco/contracts";
import { redactDiagnosticText } from "@ryco/shared/diagnosticRedaction";
import { Effect, Option } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  DELEGATION_WAKE_MESSAGE_PREFIX,
  type CompletionReturnRecord,
  type CompletionReturnRepository,
} from "../persistence/Layers/AgentControlCompletionReturns.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { readDelegatedRunState } from "../persistence/delegatedRunStatus.ts";
import type { AgentControlProposalRepositoryShape } from "../persistence/Services/AgentControlProposals.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { publishCompletionReturns } from "./completionReturnPublish.ts";
import { redactAgentControlSecrets } from "./ProviderInjection.ts";
import type { AgentControlProposalEventsShape } from "./Services/AgentControlProposalEvents.ts";

export class DelegatedTaskNotOwned {
  readonly _tag = "DelegatedTaskNotOwned";
}

export const DELEGATED_TASK_ACK_DETAIL =
  "Read by the originating chat with ryco_task_status; no automatic message needed.";
export const DELEGATED_TASK_CANCEL_DETAIL =
  "Cancelled by the delegating chat with ryco_task_cancel. No result will be returned automatically.";

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
  readonly projections: Pick<ProjectionSnapshotQueryShape, "getThreadShellById">;
  readonly sql: SqlClient.SqlClient;
}

const redact = (text: string) =>
  redactDiagnosticText(String(redactAgentControlSecrets(text))).slice(
    0,
    AGENT_CONTROL_TASK_RESULT_MAX_CHARS,
  );

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

  const describe = (record: CompletionReturnRecord, acknowledged: boolean) =>
    Effect.gen(function* () {
      const shell = yield* deps.projections.getThreadShellById(record.childThreadId);
      const child = Option.getOrNull(shell);
      const settled = record.settled;
      const result =
        settled && (settled.state === "completed" || settled.state === "error")
          ? yield* deps.repository.output(record.childThreadId, settled.turnId).pipe(
              Effect.map((output) => ({
                untrustedChildOutput: true as const,
                state: settled.state as "completed" | "error",
                text: redact(output.text.slice(0, AGENT_CONTROL_TASK_RESULT_MAX_CHARS)),
                truncated: output.text.length > AGENT_CONTROL_TASK_RESULT_MAX_CHARS,
              })),
            )
          : null;
      return {
        taskId: record.childThreadId,
        proposalId: record.proposalId,
        title: child ? redact(child.title) : null,
        return: { status: record.status, detail: record.detail, updatedAt: record.updatedAt },
        run: {
          state: yield* runState(record),
          sessionStatus: child?.session?.status ?? null,
          hasPendingApprovals: child?.hasPendingApprovals ?? false,
          // Questions are reported only as a flag; their text never crosses this boundary.
          hasPendingUserInput: child?.hasPendingUserInput ?? false,
          backgroundLiveness: child?.backgroundLiveness ?? null,
          advanced: yield* advanced(record, child),
        },
        result,
        acknowledged,
      } satisfies AgentControlTaskStatusEntry;
    });

  /**
   * A finished task read during the caller's own exact turn needs no separate wake: its
   * `ready` row becomes `delivered`. A lost race with the delivery claim just reports it.
   */
  const acknowledge = (record: CompletionReturnRecord, now: string) =>
    Effect.gen(function* () {
      if (record.status !== "ready") return { record, acknowledged: false };
      const next: CompletionReturnRecord = {
        ...record,
        status: "delivered",
        detail: DELEGATED_TASK_ACK_DETAIL,
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
    readonly acknowledge: boolean;
    readonly now: string;
  }) =>
    Effect.gen(function* () {
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
        const acked = input.acknowledge
          ? yield* acknowledge(row, input.now)
          : { record: row, acknowledged: false };
        tasks.push(yield* describe(acked.record, acked.acknowledged));
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
      if (record.status === "cancelled" && record.detail === DELEGATED_TASK_CANCEL_DETAIL)
        yield* publish(record);
      const child = yield* deps.projections.getThreadShellById(input.taskId);
      return { record, child: Option.getOrNull(child) };
    });

  return { status, cancel };
};

export type DelegatedTaskControl = ReturnType<typeof makeDelegatedTaskControl>;
