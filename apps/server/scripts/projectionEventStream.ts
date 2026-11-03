/**
 * Seeded random orchestration event streams for projection equivalence checks, shared by
 * `projection-narrow-writes-equivalence.ts` (old vs new server sources) and
 * `ProjectionPipeline.narrowWrites.test.ts` (narrow vs full-row repository writes).
 *
 * The streams exercise every event the threads and turns projectors narrow: thread activities
 * (tools, approvals, user input, stale failures), replies and system messages (streamed and
 * final, in a turn or not), a fork's inherited prompts next to the thread's own, session sets
 * (with released turns), turn starts, interrupts and diffs, and response claims. Event times
 * come from a 20-second window, so `updated_at` moves backwards and repeats, as it does in
 * production (an activity occurs at its own time).
 *
 * Only `import type` from `apps/server/src`: the old-sources run loads `src` from another commit,
 * where a module this file needs might not exist.
 */
import { createHash } from "node:crypto";

import type { OrchestrationEvent } from "@ryco/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { OrchestrationProjectionPipelineShape } from "../src/orchestration/Services/ProjectionPipeline.ts";
import type { OrchestrationEventStoreShape } from "../src/persistence/Services/OrchestrationEventStore.ts";

export interface ProjectionStreamEvent {
  /** Short description for mismatch reports, e.g. `activity:approval.requested`. */
  readonly label: string;
  readonly type: OrchestrationEvent["type"];
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}

/** mulberry32: a small seeded generator, so a failing stream replays from its seed. */
export const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const PROJECT_ID = "fixture-project";
const THREAD_IDS = ["fixture-thread-a", "fixture-thread-b"] as const;
const TURN_IDS = ["turn-1", "turn-2"] as const;
const REQUEST_IDS = ["request-1", "request-2"] as const;
const ACTIVITY_KINDS = [
  "tool.started",
  "tool.updated",
  "tool.updated",
  "tool.updated",
  "tool.completed",
  "reasoning",
  "approval.requested",
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.requested",
  "user-input.resolved",
  "user-input.response.submitted",
  "provider.user-input.respond.failed",
] as const;

/** The setup events (a project and two threads) followed by `length` random events. */
export function makeProjectionEventStream(
  seed: number,
  length: number,
): ReadonlyArray<ProjectionStreamEvent> {
  const random = mulberry32(seed);
  const pick = <T>(values: ReadonlyArray<T>): T => values[Math.floor(random() * values.length)]!;
  const t0 = Date.parse("2026-09-01T00:00:00.000Z");
  const at = () => new Date(t0 + Math.floor(random() * 20) * 1000).toISOString();
  const events: ProjectionStreamEvent[] = [];
  const thread = (
    label: string,
    type: OrchestrationEvent["type"],
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ) => events.push({ label, type, aggregateKind: "thread", aggregateId, occurredAt, payload });

  const projectAt = at();
  events.push({
    label: "project.created",
    type: "project.created",
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    occurredAt: projectAt,
    payload: {
      projectId: PROJECT_ID,
      title: "Fixture",
      workspaceRoot: "/tmp/ryco-projection-event-stream",
      defaultModelSelection: null,
      scripts: [],
      createdAt: projectAt,
      updatedAt: projectAt,
    },
  });
  for (const threadId of THREAD_IDS) {
    const createdAt = at();
    thread("thread.created", "thread.created", threadId, createdAt, {
      threadId,
      projectId: PROJECT_ID,
      title: "Fixture",
      modelSelection: { instanceId: "opencode", model: "fixture" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    });
  }

  for (let index = 0; index < length; index++) {
    const threadId = pick(THREAD_IDS);
    const occurredAt = at();
    const turnId = pick(TURN_IDS);
    const requestId = pick(REQUEST_IDS);
    const roll = random();
    if (roll < 0.1) {
      const releasedTurn =
        random() < 0.3
          ? {
              turnId: pick(TURN_IDS),
              state: pick(["completed", "interrupted", "error"] as const),
              completedAt: occurredAt,
              reason: "fixture",
            }
          : undefined;
      thread("session-set", "thread.session-set", threadId, occurredAt, {
        threadId,
        session: {
          threadId,
          status: pick(["running", "running", "ready"] as const),
          providerName: "opencode",
          runtimeSessionId: "runtime-1",
          runtimeMode: "full-access",
          activeTurnId: pick([turnId, null]),
          lastError: null,
          updatedAt: occurredAt,
        },
        ...(releasedTurn ? { releasedTurn } : {}),
      });
    } else if (roll < 0.15) {
      thread("turn-start-requested", "thread.turn-start-requested", threadId, occurredAt, {
        threadId,
        messageId: `${threadId}-user-${pick(["1", "2"])}`,
        runtimeMode: "full-access",
        interactionMode: "default",
        tokenMode: "balanced",
        createdAt: occurredAt,
      });
    } else if (roll < 0.35) {
      const sender = pick(["user", "inherited-user", "assistant", "assistant", "system"] as const);
      const role = sender === "inherited-user" ? "user" : sender;
      const localId = `${role}-${pick(["1", "2"])}`;
      thread(`message-sent:${sender}`, "thread.message-sent", threadId, occurredAt, {
        threadId,
        // A fork's inherited prompt: it does not count toward the thread's own recency.
        messageId:
          sender === "inherited-user"
            ? `${threadId}:inherited:${localId}`
            : `${threadId}-${localId}`,
        role,
        text: pick(["x", "", "more"]),
        turnId: pick([turnId, null]),
        streaming: random() < 0.6,
        createdAt: at(),
        updatedAt: occurredAt,
      });
    } else if (roll < 0.75) {
      const kind = pick(ACTIVITY_KINDS);
      const approvalIdentity =
        random() < 0.5
          ? {
              approvalIdentity: {
                requestEventId: pick(["request-event-1", "request-event-2"]),
                runtimeSessionId: pick(["runtime-1", "runtime-2"]),
              },
            }
          : {};
      const payload: Record<string, unknown> =
        kind.startsWith("tool.") || kind === "reasoning"
          ? { itemType: "command_execution", status: "inProgress", providerItemId: "call-1" }
          : kind === "approval.requested"
            ? { requestId, requestKind: "command", detail: "bun run test", ...approvalIdentity }
            : kind === "approval.resolved"
              ? {
                  requestId,
                  decision: pick(["accept", "decline"]),
                  ...(random() < 0.5 ? { runtimeSessionId: "runtime-1" } : {}),
                  ...approvalIdentity,
                }
              : kind === "provider.approval.respond.failed"
                ? { requestId, detail: pick(["stale pending approval request", "boom"]) }
                : kind === "provider.user-input.respond.failed"
                  ? { requestId, detail: pick(["stale pending user-input request", "boom"]) }
                  : kind === "user-input.requested"
                    ? { requestId, nonBlocking: random() < 0.3, questions: [] }
                    : { requestId };
      thread(`activity:${kind}`, "thread.activity-appended", threadId, occurredAt, {
        threadId,
        activity: {
          id: `activity-${seed}-${index}`,
          tone: kind.startsWith("approval.")
            ? "approval"
            : kind.startsWith("provider.")
              ? "error"
              : kind.startsWith("user-input.")
                ? "info"
                : "tool",
          kind,
          summary: kind,
          payload,
          turnId: pick([turnId, null]),
          createdAt: occurredAt,
        },
      });
    } else if (roll < 0.83) {
      thread(
        "approval-response-requested",
        "thread.approval-response-requested",
        threadId,
        occurredAt,
        { threadId, requestId, decision: pick(["accept", "decline"]), createdAt: occurredAt },
      );
    } else if (roll < 0.9) {
      thread(
        "user-input-response-requested",
        "thread.user-input-response-requested",
        threadId,
        occurredAt,
        { threadId, requestId, answers: { answer: "yes" }, createdAt: occurredAt },
      );
    } else if (roll < 0.95) {
      thread("turn-interrupt-requested", "thread.turn-interrupt-requested", threadId, occurredAt, {
        threadId,
        turnId,
        createdAt: occurredAt,
      });
    } else {
      thread("turn-diff-completed", "thread.turn-diff-completed", threadId, occurredAt, {
        threadId,
        turnId,
        checkpointTurnCount: pick([1, 2]),
        checkpointRef: `refs/ryco/checkpoints/${pick(["1", "2"])}`,
        status: pick(["ready", "ready", "missing"]),
        files: pick([[], [{ path: "src/index.ts", kind: "modified", additions: 3, deletions: 1 }]]),
        assistantMessageId: pick([null, `${threadId}-assistant-1`]),
        completedAt: occurredAt,
      });
    }
  }
  return events;
}

/** Appends one stream event and projects it in one transaction, as the engine does. */
export const applyProjectionStreamEvent = (
  store: OrchestrationEventStoreShape,
  pipeline: OrchestrationProjectionPipelineShape,
  event: ProjectionStreamEvent,
  key: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const postCommit = yield* sql.withTransaction(
      Effect.gen(function* () {
        const persisted = yield* store.append({
          type: event.type,
          payload: event.payload,
          eventId: key,
          aggregateKind: event.aggregateKind,
          aggregateId: event.aggregateId,
          occurredAt: event.occurredAt,
          commandId: key,
          causationEventId: null,
          correlationId: key,
          metadata: {},
        } as unknown as Parameters<OrchestrationEventStoreShape["append"]>[0]);
        return yield* pipeline.projectEventInTransaction(persisted);
      }),
    );
    yield* postCommit;
  });

/**
 * Every row of the projections the narrow writes touch, as JSON. `projection_turns` leaves out
 * `row_id`: its AUTOINCREMENT advances on every upsert, also one that changes nothing, so a
 * skipped no-op upsert changes later gaps but never the order the dump uses.
 */
export const dumpNarrowWriteProjections = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = [
    sql`SELECT * FROM projection_threads ORDER BY thread_id`,
    sql`
      SELECT thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
        source_proposed_plan_id, assistant_message_id, state, requested_at, started_at,
        completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
        checkpoint_files_json
      FROM projection_turns ORDER BY row_id
    `,
    sql`SELECT * FROM projection_pending_approvals ORDER BY request_id`,
    sql`SELECT * FROM projection_thread_user_input_requests ORDER BY request_id`,
    sql`SELECT * FROM projection_thread_activities ORDER BY activity_id`,
  ];
  const rows: unknown[] = [];
  for (const query of tables) rows.push(yield* query);
  return JSON.stringify(rows);
});

export const hashDump = (dump: string) => createHash("sha1").update(dump).digest("hex");

/** The highest pending counters any thread holds: proves a stream exercised the deltas. */
export const maxPendingCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    readonly approvals: number | null;
    readonly userInputs: number | null;
  }>`
    SELECT MAX(pending_approval_count) AS approvals, MAX(pending_user_input_count) AS "userInputs"
    FROM projection_threads
  `;
  return { approvals: row?.approvals ?? 0, userInputs: row?.userInputs ?? 0 };
});
