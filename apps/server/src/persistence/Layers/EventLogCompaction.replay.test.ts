/**
 * Replay equivalence of event-log compaction, as a property over generated histories.
 *
 * Histories mix every latest-state group (several keys each, versions on both sides of reverts
 * and thread re-creation) with tool lifecycles, Claude context-window gauges, approvals, meta
 * changes, archive toggles, completed turns, reverts that drop turns, and delete + re-create.
 * Each history is appended and projected live, then compacted with random small windows, batches
 * and carries. The checks:
 *
 * - P0 safety: kept rows are byte-identical, every deleted row is compactable and has a later
 *   kept row of its key, the newest row of every key stays, no gauge is deleted.
 * - P1 rebuild: projections rebuilt from the compacted log equal those rebuilt from the original
 *   (and, as a sanity check of the harness, the live projections).
 * - P2 catch-up: a database projected from the original log up to a random cursor, then caught
 *   up from the compacted log, equals the rebuild.
 * - P4 anchor: a resume probe at a deleted sequence is anchored; outside the log it is not.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  EventId,
  type OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import {
  claudeContextUsageActivityId,
  latestStateCompactionKey,
  reasoningActivityId,
  subagentMessageActivityId,
  taskProgressActivityId,
  taskUsageActivityId,
  toolProgressActivityId,
} from "@ryco/shared/latestStateActivities";
import * as fc from "fast-check";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { EventLogCompaction } from "../Services/EventLogCompaction.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { EventLogCompactionLive, ONLINE_COMPACTION_PASS_OPTIONS } from "./EventLogCompaction.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const TestLayer = Layer.mergeAll(OrchestrationProjectionPipelineLive, EventLogCompactionLive).pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "ryco-compaction-replay-test-" }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    Layer.succeed(ProjectAvatarStore, {
      write: () => Effect.die("unused"),
      read: () => Effect.succeed(null),
      remove: () => Effect.void,
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const PROJECT = ProjectId.make("project-compaction-replay");
const THREADS = [ThreadId.make("thread-replay-a"), ThreadId.make("thread-replay-b")] as const;
const LATEST_GROUPS = [
  "task-progress",
  "task-usage",
  "tool-progress",
  "subagent-message",
  "reasoning",
] as const;

type Op =
  | {
      readonly op: "latest";
      readonly thread: 0 | 1;
      readonly group: (typeof LATEST_GROUPS)[number];
      readonly key: number;
      readonly text: string;
      readonly streaming: boolean;
      readonly turn: "pending" | "last" | "none";
      readonly skewMs: number;
    }
  | { readonly op: "tool"; readonly thread: 0 | 1; readonly phase: number }
  | { readonly op: "gauge"; readonly thread: 0 | 1; readonly tokens: number }
  | { readonly op: "approval"; readonly thread: 0 | 1; readonly request: number }
  | { readonly op: "meta"; readonly thread: 0 | 1; readonly title: string }
  | { readonly op: "archive"; readonly thread: 0 | 1 }
  | { readonly op: "turn"; readonly thread: 0 | 1 }
  | { readonly op: "revert"; readonly thread: 0 | 1; readonly keep: number }
  | { readonly op: "recreate"; readonly thread: 0 | 1 };

const threadIndex = fc.constantFrom<0 | 1>(0, 1);
const arbitraryOp: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 10,
    arbitrary: fc.record({
      op: fc.constant("latest" as const),
      thread: threadIndex,
      group: fc.constantFrom(...LATEST_GROUPS),
      key: fc.integer({ min: 0, max: 2 }),
      text: fc.string({ maxLength: 12 }),
      streaming: fc.boolean(),
      turn: fc.constantFrom("pending" as const, "last" as const, "none" as const),
      skewMs: fc.oneof(fc.constant(0), fc.integer({ min: -5_000, max: 5_000 })),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant("tool" as const),
      thread: threadIndex,
      phase: fc.integer({ min: 0, max: 2 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant("gauge" as const),
      thread: threadIndex,
      tokens: fc.integer({ min: 1, max: 100_000 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant("approval" as const),
      thread: threadIndex,
      request: fc.integer({ min: 0, max: 1 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant("meta" as const),
      thread: threadIndex,
      title: fc.string({ minLength: 1, maxLength: 8 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("archive" as const), thread: threadIndex }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("turn" as const), thread: threadIndex }) },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant("revert" as const),
      thread: threadIndex,
      keep: fc.integer({ min: 0, max: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ op: fc.constant("recreate" as const), thread: threadIndex }),
  },
);

type EventSpec = Omit<
  Parameters<(typeof OrchestrationEventStore)["Service"]["append"]>[0],
  "eventId" | "commandId" | "causationEventId" | "correlationId" | "metadata"
>;

/** Turns generated ops into a valid event history (thread state tracked as a server would). */
function materialize(ops: ReadonlyArray<Op>): Array<EventSpec> {
  let clockMs = Date.parse("2026-09-01T00:00:00.000Z");
  const at = (skewMs = 0) => {
    clockMs += 1_000;
    return new Date(clockMs + skewMs).toISOString();
  };
  const events: Array<EventSpec> = [];
  const created = at();
  events.push({
    type: "project.created",
    aggregateKind: "project",
    aggregateId: PROJECT,
    occurredAt: created,
    payload: {
      projectId: PROJECT,
      title: "Replay",
      workspaceRoot: "/tmp/replay",
      defaultModelSelection: null,
      scripts: [],
      createdAt: created,
      updatedAt: created,
    },
  } as EventSpec);
  const state = THREADS.map(() => ({
    turns: [] as Array<TurnId>,
    turnCounter: 0,
    archived: false,
    toolCounter: 0,
  }));
  const createThread = (index: 0 | 1) => {
    const occurredAt = at();
    events.push({
      type: "thread.created",
      aggregateKind: "thread",
      aggregateId: THREADS[index],
      occurredAt,
      payload: {
        threadId: THREADS[index],
        projectId: PROJECT,
        title: `Thread ${index}`,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    } as EventSpec);
    state[index] = {
      turns: [],
      turnCounter: state[index]!.turnCounter,
      archived: false,
      toolCounter: 0,
    };
  };
  createThread(0);
  createThread(1);

  const activity = (
    index: 0 | 1,
    input: {
      readonly id: string;
      readonly kind: string;
      readonly payload: unknown;
      readonly turnId: TurnId | null;
      readonly skewMs?: number;
      readonly tone?: "info" | "tool" | "approval";
    },
  ) => {
    const occurredAt = at();
    const createdAt = new Date(Date.parse(occurredAt) + (input.skewMs ?? 0)).toISOString();
    events.push({
      type: "thread.activity-appended",
      aggregateKind: "thread",
      aggregateId: THREADS[index],
      occurredAt,
      payload: {
        threadId: THREADS[index],
        activity: {
          id: EventId.make(input.id),
          tone: input.tone ?? "info",
          kind: input.kind,
          summary: `${input.kind} summary`,
          payload: input.payload,
          turnId: input.turnId,
          createdAt,
        },
      },
    } as EventSpec);
  };

  for (const op of ops) {
    const threadId = THREADS[op.thread];
    const thread = state[op.thread]!;
    const pendingTurn = TurnId.make(`${threadId}-turn-${thread.turnCounter + 1}`);
    switch (op.op) {
      case "latest": {
        const turnId =
          op.turn === "pending"
            ? pendingTurn
            : op.turn === "last"
              ? (thread.turns.at(-1) ?? null)
              : null;
        const key = `task-${op.key}`;
        const id =
          op.group === "task-progress"
            ? taskProgressActivityId(threadId, key)
            : op.group === "task-usage"
              ? taskUsageActivityId(threadId, key)
              : op.group === "tool-progress"
                ? toolProgressActivityId(threadId, key)
                : op.group === "subagent-message"
                  ? subagentMessageActivityId({
                      threadId,
                      providerThreadId: "provider-thread",
                      providerItemId: key,
                    })
                  : reasoningActivityId(threadId, turnId, key);
        const kind =
          op.group === "task-progress" || op.group === "task-usage"
            ? "task.progress"
            : op.group === "tool-progress"
              ? "tool.progress"
              : op.group === "subagent-message"
                ? "agent.message"
                : "reasoning";
        activity(op.thread, {
          id,
          kind,
          payload: { taskId: key, text: op.text, streaming: op.streaming },
          turnId,
          skewMs: op.skewMs,
        });
        break;
      }
      case "tool": {
        thread.toolCounter += op.phase === 0 ? 1 : 0;
        const kinds = ["tool.started", "tool.updated", "tool.completed"] as const;
        activity(op.thread, {
          id: `${threadId}-tool-${thread.toolCounter}-${kinds[op.phase]}-${events.length}`,
          kind: kinds[op.phase]!,
          payload: { itemType: "command_execution", title: "Bash" },
          turnId: pendingTurn,
          tone: "tool",
        });
        break;
      }
      case "gauge":
        activity(op.thread, {
          id: claudeContextUsageActivityId(threadId),
          kind: "context-window.updated",
          payload: { usedTokens: op.tokens, lastInputTokens: op.tokens, lastOutputTokens: 1 },
          turnId: pendingTurn,
        });
        break;
      case "approval": {
        const requestId = `${threadId}-request-${op.request}`;
        activity(op.thread, {
          id: `${requestId}-requested-${events.length}`,
          kind: "approval.requested",
          payload: { requestId, requestKind: "command", detail: "run it" },
          turnId: pendingTurn,
          tone: "approval",
        });
        activity(op.thread, {
          id: `${requestId}-resolved-${events.length}`,
          kind: "approval.resolved",
          payload: { requestId, decision: "accept" },
          turnId: pendingTurn,
          tone: "approval",
        });
        break;
      }
      case "meta": {
        const occurredAt = at();
        events.push({
          type: "thread.meta-updated",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          payload: { threadId, title: `Title ${op.title.trim() || "x"}`, updatedAt: occurredAt },
        } as EventSpec);
        break;
      }
      case "archive": {
        const occurredAt = at();
        events.push(
          (thread.archived
            ? {
                type: "thread.unarchived",
                aggregateKind: "thread",
                aggregateId: threadId,
                occurredAt,
                payload: { threadId, updatedAt: occurredAt },
              }
            : {
                type: "thread.archived",
                aggregateKind: "thread",
                aggregateId: threadId,
                occurredAt,
                payload: { threadId, archivedAt: occurredAt, updatedAt: occurredAt },
              }) as EventSpec,
        );
        thread.archived = !thread.archived;
        break;
      }
      case "turn": {
        thread.turnCounter += 1;
        thread.turns.push(pendingTurn);
        const occurredAt = at();
        events.push({
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          payload: {
            threadId,
            turnId: pendingTurn,
            checkpointTurnCount: thread.turns.length,
            checkpointRef: CheckpointRef.make(
              `refs/ryco/checkpoints/${threadId}/${thread.turns.length}`,
            ),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: occurredAt,
          },
        } as EventSpec);
        break;
      }
      case "revert": {
        const keep = Math.min(op.keep, thread.turns.length);
        const dropped = thread.turns.slice(keep);
        thread.turns = thread.turns.slice(0, keep);
        events.push({
          type: "thread.reverted",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: at(),
          payload: { threadId, turnCount: keep, droppedTurnIds: dropped },
        } as EventSpec);
        break;
      }
      case "recreate": {
        events.push({
          type: "thread.deleted",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: at(),
          payload: { threadId, deletedAt: new Date(clockMs).toISOString() },
        } as EventSpec);
        createThread(op.thread);
        break;
      }
    }
  }
  return events;
}

interface RawEventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly aggregate_kind: string;
  readonly stream_id: string;
  readonly stream_version: number;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly command_id: string | null;
  readonly causation_event_id: string | null;
  readonly correlation_id: string | null;
  readonly actor_kind: string;
  readonly payload_json: string;
  readonly metadata_json: string;
}

const readRawRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<RawEventRow>`SELECT * FROM orchestration_events ORDER BY sequence`;
});

const insertRawRows = (rows: ReadonlyArray<RawEventRow>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const row of rows) {
      yield* sql`INSERT INTO orchestration_events ${sql.insert(row as unknown as Record<string, unknown>)}`;
    }
  });

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).toSorted(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : inner,
  );

/** Every projection table (search index and cursors aside), rows in canonical order. */
const dumpProjections = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name LIKE 'projection_%' AND name <> 'projection_state'
      AND name NOT LIKE 'projection_message_search%'
    ORDER BY name
  `;
  const dump: Record<string, ReadonlyArray<string>> = {};
  for (const { name } of tables) {
    const rows = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM "${name}"`);
    if (rows.length > 0) dump[name] = rows.map(canonical).toSorted();
  }
  return dump;
});

const rebuildFrom = (batches: ReadonlyArray<ReadonlyArray<RawEventRow>>) =>
  Effect.gen(function* () {
    const pipeline = yield* OrchestrationProjectionPipeline;
    for (const rows of batches) {
      yield* insertRawRows(rows);
      yield* pipeline.bootstrap;
    }
    return yield* dumpProjections;
  }).pipe(Effect.provide(TestLayer));

const compactionKeyOf = (row: RawEventRow): string | null => {
  if (row.event_type !== "thread.activity-appended") return null;
  const payload = JSON.parse(row.payload_json) as { activity?: { id?: string; kind?: string } };
  return latestStateCompactionKey(row.stream_id, {
    id: payload.activity?.id ?? null,
    kind: payload.activity?.kind ?? null,
  });
};

const checkHistory = (input: {
  readonly ops: ReadonlyArray<Op>;
  readonly pageSequences: number;
  readonly batch: number;
  readonly carry: number;
  readonly cursorShare: number;
  readonly probeShare: number;
}) =>
  Effect.gen(function* () {
    const specs = materialize(input.ops);

    // Live: append and project each event as the engine does, then compact.
    const live = yield* Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const compaction = yield* EventLogCompaction;
      let serial = 0;
      for (const spec of specs) {
        serial += 1;
        const event = yield* store.append({
          ...spec,
          eventId: EventId.make(`evt-replay-${serial}`),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        } as Parameters<typeof store.append>[0]);
        yield* pipeline.projectEvent(event as OrchestrationEvent);
      }
      const liveDump = yield* dumpProjections;
      const original = yield* readRawRows;
      const result = yield* compaction.runPass({
        ...ONLINE_COMPACTION_PASS_OPTIONS,
        horizon: "head",
        maxScanSequences: Number.POSITIVE_INFINITY,
        maxWallMs: Number.POSITIVE_INFINITY,
        selectionPageSequences: input.pageSequences,
        deleteBatch: { initial: input.batch, min: 1, max: input.batch, targetMs: 8 },
        interBatchPauseMs: 0,
        idleRatio: 0,
        carryCapacity: input.carry,
        receipts: null,
      });
      const compacted = yield* readRawRows;
      const keptSequences = new Set(compacted.map((row) => row.sequence));
      const deleted = original.filter((row) => !keptSequences.has(row.sequence));
      // P4: the log's range anchors a resume, including inside a hole.
      const probe = store.probeResume!;
      const head = original.at(-1)!.sequence;
      const probeTarget = deleted[Math.floor(input.probeShare * deleted.length)];
      if (probeTarget !== undefined) {
        expect((yield* probe({ sequence: probeTarget.sequence, limit: 10 })).anchored).toBe(true);
      }
      expect((yield* probe({ sequence: head + 1, limit: 10 })).anchored).toBe(false);
      expect((yield* probe({ sequence: 0, limit: 10 })).anchored).toBe(false);
      return { liveDump, original, compacted, deleted, result };
    }).pipe(Effect.provide(TestLayer));

    const { original, compacted, deleted } = live;
    expect(live.result.deletedEvents).toBe(deleted.length);

    // P0: safety of the deleted set.
    const originalBySequence = new Map(original.map((row) => [row.sequence, row]));
    for (const row of compacted) expect(row).toEqual(originalBySequence.get(row.sequence));
    const newestByKey = new Map<string, number>();
    for (const row of original) {
      const key = compactionKeyOf(row);
      if (key !== null) newestByKey.set(key, row.sequence);
    }
    for (const row of deleted) {
      const key = compactionKeyOf(row);
      expect(key, row.payload_json).not.toBeNull();
      expect(newestByKey.get(key!)).not.toBe(row.sequence);
      expect(row.payload_json).not.toContain('"context-window.updated"');
      expect(
        compacted.some((kept) => kept.sequence > row.sequence && compactionKeyOf(kept) === key),
      ).toBe(true);
    }
    if (input.carry === Number.POSITIVE_INFINITY) {
      // Unbounded carry in one pass: exactly every superseded version goes.
      const superseded = original.filter((row) => {
        const key = compactionKeyOf(row);
        return key !== null && newestByKey.get(key) !== row.sequence;
      });
      expect(deleted.map((row) => row.sequence)).toEqual(superseded.map((row) => row.sequence));
    }

    // P1: rebuilding from the compacted log equals rebuilding from the original one.
    const rebuiltOriginal = yield* rebuildFrom([original]);
    const rebuiltCompacted = yield* rebuildFrom([compacted]);
    expect(rebuiltCompacted).toEqual(rebuiltOriginal);
    // Harness sanity: live projection and rebuild agree on the original log.
    expect(rebuiltOriginal).toEqual(live.liveDump);

    // P2: projected from the original up to a cursor, then caught up from the compacted log.
    const cursor = Math.floor(input.cursorShare * (original.at(-1)!.sequence + 1));
    const caughtUp = yield* rebuildFrom([
      original.filter((row) => row.sequence <= cursor),
      compacted.filter((row) => row.sequence > cursor),
    ]);
    expect(caughtUp).toEqual(rebuiltOriginal);
    return deleted.length;
  });

describe("event-log compaction replay equivalence", () => {
  it("rebuilds, catches up and resumes to the same state", { timeout: 120_000 }, async () => {
    let totalDeleted = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          ops: fc.array(arbitraryOp, { minLength: 1, maxLength: 120, size: "max" }),
          pageSequences: fc.integer({ min: 1, max: 50 }),
          batch: fc.integer({ min: 1, max: 20 }),
          carry: fc.oneof(fc.integer({ min: 0, max: 10 }), fc.constant(Number.POSITIVE_INFINITY)),
          cursorShare: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
          probeShare: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        }),
        async (input) => {
          totalDeleted += await Effect.runPromise(checkHistory(input));
        },
      ),
      { numRuns: 150 },
    );
    // The generator must actually exercise deletion.
    expect(totalDeleted).toBeGreaterThan(0);
  });
});
