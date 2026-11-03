/**
 * A client resuming from any cursor reaches the same thread state whether the server replays the
 * original event log or the compacted one (superseded latest-state versions removed by
 * `selectSupersededLatestStateEvents`). Histories stay under the client's activity cap, where the
 * store keeps every activity, and include reverts that drop turns and delete + re-create.
 */
import { CheckpointRef, EventId, ThreadId, TurnId } from "@ryco/contracts/base-schemas";
import type { OrchestrationEvent } from "@ryco/contracts/orchestration";
import { ProviderInstanceId } from "@ryco/contracts/provider-instance";
import {
  claudeContextUsageActivityId,
  reasoningActivityId,
  selectSupersededLatestStateEvents,
  subagentMessageActivityId,
  taskProgressActivityId,
  taskUsageActivityId,
  toolProgressActivityId,
} from "@ryco/shared/latestStateActivities";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { applyOrchestrationEvents, type AppState, selectEnvironmentState } from "./store.ts";
import { localEnvironmentId, makeState, makeThread } from "./store.testSupport.ts";

const THREAD = ThreadId.make("thread-compaction-client");
const PROJECT = "project-1";
const GROUPS = ["task", "usage", "tool", "subagent", "reasoning"] as const;

type Op =
  | {
      readonly op: "latest";
      readonly group: (typeof GROUPS)[number];
      readonly key: number;
      readonly text: string;
      readonly streaming: boolean;
      readonly turn: "pending" | "last" | "none";
      readonly skewMs: number;
    }
  | { readonly op: "tool" }
  | { readonly op: "gauge"; readonly tokens: number }
  | { readonly op: "turn" }
  | { readonly op: "revert"; readonly keep: number }
  | { readonly op: "recreate" }
  | { readonly op: "archive" };

const arbitraryOp: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 12,
    arbitrary: fc.record({
      op: fc.constant("latest" as const),
      group: fc.constantFrom(...GROUPS),
      key: fc.integer({ min: 0, max: 3 }),
      text: fc.string({ maxLength: 10 }),
      streaming: fc.boolean(),
      turn: fc.constantFrom("pending" as const, "last" as const, "none" as const),
      skewMs: fc.oneof(fc.constant(0), fc.integer({ min: -3_000, max: 3_000 })),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ op: "tool" as const }) },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant("gauge" as const),
      tokens: fc.integer({ min: 1, max: 9_999 }),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ op: "turn" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant("revert" as const),
      keep: fc.integer({ min: 0, max: 3 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ op: "recreate" as const }) },
  { weight: 1, arbitrary: fc.constant({ op: "archive" as const }) },
);

function buildLog(ops: ReadonlyArray<Op>): Array<OrchestrationEvent> {
  const events: Array<OrchestrationEvent> = [];
  let clockMs = Date.parse("2026-09-01T00:00:00.000Z");
  let turns: Array<TurnId> = [];
  let turnCounter = 0;
  let toolCounter = 0;
  let archived = false;
  const push = (
    type: OrchestrationEvent["type"],
    payload: unknown,
    occurredAt = new Date((clockMs += 1_000)).toISOString(),
  ) => {
    const sequence = events.length + 1;
    events.push({
      sequence,
      eventId: EventId.make(`event-client-compaction-${sequence}`),
      aggregateKind: "thread",
      aggregateId: THREAD,
      occurredAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type,
      payload,
    } as OrchestrationEvent);
  };
  const activity = (input: {
    readonly id: string;
    readonly kind: string;
    readonly payload: unknown;
    readonly turnId: TurnId | null;
    readonly skewMs?: number;
  }) => {
    clockMs += 1_000;
    push(
      "thread.activity-appended",
      {
        threadId: THREAD,
        activity: {
          id: EventId.make(input.id),
          tone: "info",
          kind: input.kind,
          summary: `${input.kind} summary`,
          payload: input.payload,
          turnId: input.turnId,
          createdAt: new Date(clockMs + (input.skewMs ?? 0)).toISOString(),
        },
      },
      new Date(clockMs).toISOString(),
    );
  };

  for (const op of ops) {
    const pendingTurn = TurnId.make(`${THREAD}-turn-${turnCounter + 1}`);
    switch (op.op) {
      case "latest": {
        const turnId =
          op.turn === "pending" ? pendingTurn : op.turn === "last" ? (turns.at(-1) ?? null) : null;
        const key = `task-${op.key}`;
        const [id, kind] =
          op.group === "task"
            ? [taskProgressActivityId(THREAD, key), "task.progress"]
            : op.group === "usage"
              ? [taskUsageActivityId(THREAD, key), "task.progress"]
              : op.group === "tool"
                ? [toolProgressActivityId(THREAD, key), "tool.progress"]
                : op.group === "subagent"
                  ? [
                      subagentMessageActivityId({
                        threadId: THREAD,
                        providerThreadId: "provider-thread",
                        providerItemId: key,
                      }),
                      "agent.message",
                    ]
                  : [reasoningActivityId(THREAD, turnId, key), "reasoning"];
        activity({
          id,
          kind,
          payload: { taskId: key, text: op.text, streaming: op.streaming },
          turnId,
          skewMs: op.skewMs,
        });
        break;
      }
      case "tool":
        toolCounter += 1;
        activity({
          id: `${THREAD}-tool-${toolCounter}`,
          kind: "tool.completed",
          payload: { title: "Bash" },
          turnId: pendingTurn,
        });
        break;
      case "gauge":
        activity({
          id: claudeContextUsageActivityId(THREAD),
          kind: "context-window.updated",
          payload: { usedTokens: op.tokens },
          turnId: pendingTurn,
        });
        break;
      case "turn": {
        turnCounter += 1;
        turns.push(pendingTurn);
        const completedAt = new Date((clockMs += 1_000)).toISOString();
        push("thread.turn-diff-completed", {
          threadId: THREAD,
          turnId: pendingTurn,
          checkpointTurnCount: turns.length,
          checkpointRef: CheckpointRef.make(`refs/ryco/checkpoints/${THREAD}/${turns.length}`),
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt,
        });
        break;
      }
      case "revert": {
        const keep = Math.min(op.keep, turns.length);
        const droppedTurnIds = turns.slice(keep);
        turns = turns.slice(0, keep);
        push("thread.reverted", { threadId: THREAD, turnCount: keep, droppedTurnIds });
        break;
      }
      case "recreate": {
        const at = new Date((clockMs += 1_000)).toISOString();
        push("thread.deleted", { threadId: THREAD, deletedAt: at }, at);
        const createdAt = new Date((clockMs += 1_000)).toISOString();
        push(
          "thread.created",
          {
            threadId: THREAD,
            projectId: PROJECT,
            title: "Thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
          createdAt,
        );
        turns = [];
        archived = false;
        break;
      }
      case "archive": {
        const at = new Date((clockMs += 1_000)).toISOString();
        if (archived) {
          push("thread.unarchived", { threadId: THREAD, updatedAt: at }, at);
        } else {
          push("thread.archived", { threadId: THREAD, archivedAt: at, updatedAt: at }, at);
        }
        archived = !archived;
        break;
      }
    }
  }
  return events;
}

function compact(log: ReadonlyArray<OrchestrationEvent>): Array<OrchestrationEvent> {
  const rows = log.flatMap((event) =>
    event.type === "thread.activity-appended"
      ? [
          {
            sequence: event.sequence,
            streamId: event.aggregateId,
            activityId: event.payload.activity.id,
            kind: event.payload.activity.kind,
            bytes: 0,
          },
        ]
      : [],
  );
  const { deletions } = selectSupersededLatestStateEvents(rows, new Map());
  const deleted = new Set(deletions.map((deletion) => deletion.sequence));
  return log.filter((event) => !deleted.has(event.sequence));
}

function apply(state: AppState, events: ReadonlyArray<OrchestrationEvent>): AppState {
  return events.length === 0 ? state : applyOrchestrationEvents(state, events, localEnvironmentId);
}

function threadView(state: AppState) {
  const environment = selectEnvironmentState(state, localEnvironmentId);
  return {
    activityIds: environment.activityIdsByThreadId[THREAD] ?? null,
    activities: environment.activityByThreadId[THREAD] ?? null,
    shell: environment.threadShellById[THREAD] ?? null,
  };
}

describe("client replay of a compacted event log", () => {
  it("reaches the same thread state from every cursor", () => {
    let compactedAway = 0;
    fc.assert(
      fc.property(
        fc.array(arbitraryOp, { minLength: 1, maxLength: 400, size: "max" }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        fc.boolean(),
        (ops, cursorShare, oneByOne) => {
          const original = buildLog(ops);
          const compacted = compact(original);
          compactedAway += original.length - compacted.length;
          const cursor = Math.floor(cursorShare * (original.length + 1));
          const initial = makeState(makeThread({ id: THREAD }));
          const atCursor = apply(
            initial,
            original.filter((event) => event.sequence <= cursor),
          );
          const replay = (log: ReadonlyArray<OrchestrationEvent>) => {
            const missed = log.filter((event) => event.sequence > cursor);
            // Replay arrives in pages or event by event; both must agree.
            return oneByOne
              ? missed.reduce((state, event) => apply(state, [event]), atCursor)
              : apply(atCursor, missed);
          };
          expect(threadView(replay(compacted))).toEqual(threadView(replay(original)));
        },
      ),
      { numRuns: 200 },
    );
    expect(compactedAway).toBeGreaterThan(0);
  });
});
