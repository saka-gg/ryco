import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  AgentControlProposal,
  MessageId,
  OrchestrationThreadShell,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type ClientOrchestrationCommand,
} from "@ryco/contracts";
import {
  CompletionReturnRepository,
  CompletionReturnRepositoryLive,
  makeCompletionReturnRepository,
} from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import { AgentControlProposalRepositoryLive } from "../../persistence/Layers/AgentControlProposals.ts";
import {
  AgentControlPrincipalScope,
  AgentControlProposalRepository,
} from "../../persistence/Services/AgentControlProposals.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandApplication } from "../../orchestration/Services/OrchestrationCommandApplication.ts";
import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import { AgentControlProposalEventsLive } from "./AgentControlProposalEvents.ts";
import { completionFixture, completionFixtureTime as now } from "../completionReturnTestSupport.ts";
import {
  completionReturnCommandId,
  makeCompletionReturnDelivery,
  renderCompletionReturn,
} from "./CompletionReturnDelivery.ts";

import { ProviderService } from "../../provider/Services/ProviderService.ts";

const layer = Layer.mergeAll(
  CompletionReturnRepositoryLive,
  AgentControlProposalRepositoryLive,
  OrchestrationCommandReceiptRepositoryLive,
  AgentControlProposalEventsLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const shell = (id: string, turn: string, runtime: string) =>
  Schema.decodeUnknownSync(OrchestrationThreadShell)({
    id,
    projectId: "project-1",
    title: id,
    modelSelection: { instanceId: "codex", model: "fixture" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: turn,
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    session: {
      threadId: id,
      status: "ready",
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeSessionId: runtime,
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
    latestUserMessageAt: now,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });
const setup = Effect.gen(function* () {
  const repo = yield* CompletionReturnRepository;
  const sql = yield* SqlClient.SqlClient;
  const proposals = yield* AgentControlProposalRepository;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const events = yield* AgentControlProposalEvents;
  const row = completionFixture();
  yield* repo.insert(row);
  const proposal = Schema.decodeUnknownSync(AgentControlProposal)({
    proposalId: row.proposalId,
    requestId: "request",
    principal: {
      kind: "provider-session",
      threadId: "parent",
      providerInstanceId: "codex",
      runtimeSessionId: "parent-runtime",
      turnId: "parent-turn",
    },
    planVersion: 1,
    plan: {
      kind: "createThreads",
      entries: [
        {
          projectId: "project-1",
          title: "Fixture",
          prompt: "Fixture task",
          modelSelection: { instanceId: "codex", model: "fixture" },
          runtimeMode: "approval-required",
          envMode: "local",
          returnToOrigin: true,
        },
      ],
    },
    planDigest: "a".repeat(64),
    riskTags: [],
    promptSummary: null,
    status: "completed",
    createdAt: now,
    updatedAt: now,
    expiresAt: now,
    decidedAt: now,
    result: null,
  });
  yield* proposals.insert({ proposal, principalScope: AgentControlPrincipalScope.make("fixture") });
  // A finalized assistant message alone intentionally looks completed in the
  // existing projection. It must not release a return without ingestion's ack.
  yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
    VALUES ('child', 'child-turn', 'child-initial', 'answer', 'completed', ${now}, ${now}, ${now}, '[]')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('answer', 'child', 'child-turn', 'assistant', ${"Result ".repeat(1800)}, 0, ${now}, ${now})`;
  yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
    VALUES ('parent', 'parent-turn', 'parent-initial', 'completed', ${now}, '[]')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('parent-initial', 'parent', NULL, 'user', 'Fixture parent', 0, ${now}, ${now})`;
  let parent: OrchestrationThreadShell | null = shell("parent", "parent-turn", "parent-runtime");
  let child: OrchestrationThreadShell | null = shell("child", "child-turn", "child-runtime");
  let enabled = true;
  let liveRuntime: string | null = "parent-runtime";
  let failReads = false;
  let ambiguous = false;
  let simulatePendingReturn = false;
  const sent: ClientOrchestrationCommand[] = [];
  const makeWorker = makeCompletionReturnDelivery.pipe(
    Effect.provideService(ProviderService, {
      getSession: () =>
        Effect.sync(() =>
          liveRuntime === null
            ? Option.none()
            : Option.some({ runtimeSessionId: liveRuntime, providerInstanceId: "codex" }),
        ),
    } as never),
    Effect.provideService(ProjectionSnapshotQuery, {
      getThreadShellById: (id: ThreadId) =>
        failReads
          ? Effect.fail(new Error("fixture transient"))
          : Effect.succeed(Option.fromNullishOr(id === "parent" ? parent : child)),
    } as never),
    Effect.provideService(OrchestrationCommandApplication, {
      apply: (command: ClientOrchestrationCommand) =>
        Effect.gen(function* () {
          sent.push(command);
          if (ambiguous) return yield* Effect.fail(new Error("lost acknowledgement"));
          yield* receipts.upsert({
            commandId: command.commandId,
            aggregateId: row.parentThreadId,
            aggregateKind: "thread",
            acceptedAt: now,
            resultSequence: 1,
            status: "accepted",
            error: null,
          });
          if (simulatePendingReturn && command.type === "thread.turn.start") {
            yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
              VALUES ('parent', NULL, ${command.message.messageId}, 'pending', ${command.createdAt}, '[]')`;
          }
          return { sequence: 1 };
        }),
    } as never),
    Effect.provideService(AgentControlPolicy, { isEnabled: Effect.sync(() => enabled) } as never),
  );
  const worker = yield* makeWorker;
  const read = () => repo.get(row.childThreadId).pipe(Effect.map((r) => r!));
  const ack = (
    state: "completed" | "error" | "interrupted" = "completed",
    backgroundPending = false,
    epoch = "process-1",
  ) =>
    repo.observe({
      childThreadId: row.childThreadId,
      runtimeSessionId: RuntimeSessionId.make("child-runtime"),
      observationEpoch: epoch,
      backgroundPending,
      terminal: { turnId: TurnId.make("child-turn"), state },
    });
  const tick = (seconds: number) =>
    worker.scan(new Date(Date.parse(now) + seconds * 1000).toISOString());
  return {
    repo,
    sql,
    read,
    ack,
    tick,
    makeWorker,
    receipts,
    events,
    sent,
    setLiveRuntime: (value: string | null) => {
      liveRuntime = value;
    },
    setParent: (value: OrchestrationThreadShell | null) => {
      parent = value;
    },
    setChild: (value: OrchestrationThreadShell | null) => {
      child = value;
    },
    disable: () => {
      enabled = false;
    },
    failReads: (value: boolean) => {
      failReads = value;
    },
    modelPendingReturn: () => {
      simulatePendingReturn = true;
    },
    ambiguous: () => {
      ambiguous = true;
    },
  };
});

it.effect(
  "waits for authoritative completion, background settlement and parent idle; dispatches once with bounded attribution",
  () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.tick(0);
      assert.equal((yield* h.read()).status, "waiting");
      yield* h.ack("completed", true);
      yield* h.tick(3);
      assert.equal(h.sent.length, 0);
      yield* h.ack("completed", false);
      const busy = shell("parent", "parent-turn", "parent-runtime");
      h.setParent({
        ...busy,
        session: { ...busy.session!, status: "running", activeTurnId: TurnId.make("parent-turn") },
      });
      yield* h.tick(6);
      assert.equal((yield* h.read()).status, "ready");
      yield* h.tick(9);
      assert.equal(h.sent.length, 0);
      h.setParent(busy);
      yield* h.tick(12);
      assert.equal((yield* h.read()).status, "delivered");
      yield* h.tick(15);
      const restarted = yield* h.makeWorker;
      yield* restarted.scan(new Date(Date.parse(now) + 18000).toISOString());
      assert.equal(h.sent.length, 1);
      const command = h.sent[0]!;
      assert.equal(command.type, "thread.turn.start");
      if (command.type !== "thread.turn.start") return;
      assert.include(command.message.text, '"truncated":true');
      assert.include(command.message.text, "Untrusted child output");
      assert.include(command.message.text, "/ryco/thread/parent");
      assert.isBelow(command.message.text.length, 12000);
      assert.equal(command.delegationReturnGuard?.runtimeSessionId, "parent-runtime");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "reopens persisted records and resolves an accepted ambiguous dispatch before checking the advanced parent",
  () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.ack();
      yield* h.tick(0);
      const ready = yield* h.read();
      yield* h.repo.save(ready, { ...ready, status: "dispatching" });
      yield* h.receipts.upsert({
        commandId: completionReturnCommandId(ready),
        aggregateKind: "thread",
        aggregateId: ready.parentThreadId,
        acceptedAt: now,
        resultSequence: 2,
        status: "accepted",
        error: null,
      });
      h.setParent(shell("parent", "newer", "different-runtime"));
      const reopened = yield* makeCompletionReturnRepository;
      assert.equal((yield* reopened.get(ready.childThreadId))?.status, "dispatching");
      const restarted = yield* h.makeWorker;
      yield* restarted.scan(new Date(Date.parse(now) + 3000).toISOString());
      assert.equal((yield* h.read()).status, "delivered");
      assert.equal(h.sent.length, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("does not replay unknown dispatch and exposes an actionable uncertain result", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.ack();
    yield* h.tick(0);
    h.ambiguous();
    yield* h.tick(3);
    assert.equal((yield* h.read()).status, "uncertain");
    assert.include((yield* h.read()).detail, "Check the parent");
    yield* h.tick(6);
    assert.equal(h.sent.length, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "retries transient reads, but never interprets a new process's empty background registry as settled",
  () =>
    Effect.gen(function* () {
      const h = yield* setup;
      h.failReads(true);
      yield* h.tick(0);
      assert.include((yield* h.read()).detail, "retrying");
      h.failReads(false);
      yield* h.ack("completed", true);
      yield* h.ack("completed", false, "process-2");
      yield* h.tick(3);
      assert.equal((yield* h.read()).status, "waiting");
      yield* h.tick(24 * 60 * 60 + 1);
      assert.equal((yield* h.read()).status, "failed");
      assert.equal(h.sent.length, 0);
    }).pipe(Effect.provide(layer)),
);

for (const boundary of [
  "parent-turn",
  "parent-runtime",
  "parent-archived",
  "parent-deleted",
  "child-new-turn",
  "child-deleted",
  "child-interrupted",
  "disabled",
] as const) {
  it.effect(`refuses automatic delivery across ${boundary}`, () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.ack(boundary === "child-interrupted" ? "interrupted" : "completed");
      if (boundary === "parent-turn") h.setParent(shell("parent", "new-turn", "parent-runtime"));
      if (boundary === "parent-runtime") h.setParent(shell("parent", "parent-turn", "new-runtime"));
      if (boundary === "parent-archived")
        h.setParent({ ...shell("parent", "parent-turn", "parent-runtime"), archivedAt: now });
      if (boundary === "parent-deleted") h.setParent(null);
      if (boundary === "child-new-turn") h.setChild(shell("child", "new-turn", "child-runtime"));
      if (boundary === "child-deleted") h.setChild(null);
      if (boundary === "disabled") h.disable();
      yield* h.tick(0);
      yield* h.tick(3);
      assert.include(["blocked", "cancelled"], (yield* h.read()).status);
      assert.equal(h.sent.length, 0);
    }).pipe(Effect.provide(layer)),
  );
}

it.effect(
  "returns a failed initial run without calling it successful and ignores unrelated turn acknowledgement",
  () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.repo.observe({
        childThreadId: ThreadId.make("child"),
        runtimeSessionId: RuntimeSessionId.make("child-runtime"),
        observationEpoch: "process-1",
        backgroundPending: false,
        terminal: { turnId: TurnId.make("unrelated"), state: "completed" },
      });
      assert.equal((yield* h.read()).settled, null);
      yield* h.ack("error");
      yield* h.tick(0);
      yield* h.tick(3);
      assert.equal((yield* h.read()).status, "delivered");
      const command = h.sent[0]!;
      assert.equal(command.type, "thread.turn.start");
      if (command.type === "thread.turn.start")
        assert.include(command.message.text, "initial child run failed");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps initial message ownership immutable on repeated insert and rejects stale writers",
  () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const first = yield* h.read();
      yield* h.repo.insert({ ...first, initialMessageId: MessageId.make("another-run") });
      yield* h.ack();
      assert.isFalse(yield* h.repo.save(first, { ...first, status: "cancelled" }));
      assert.equal((yield* h.read()).initialMessageId, first.initialMessageId);
      const hostile = '\\"\n\u0000'.repeat(9000);
      assert.isBelow(renderCompletionReturn(yield* h.read(), hostile).length, 50000);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "delivers two siblings through proven return continuation lineage, including after worker restart",
  () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.ack();
      yield* h.tick(0);
      yield* h.tick(3);
      const first = yield* h.read();
      assert.equal(first.status, "delivered");
      if (first.command?.type !== "thread.turn.start") throw new Error("expected saved return");
      // Model the authoritative projection binding the accepted return's message to
      // its provider turn, using the original frozen command timestamp.
      yield* h.sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
    VALUES ('parent', 'return-continuation', ${first.command.message.messageId}, 'completed', ${first.command.createdAt}, '[]')`;
      yield* h.sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
    VALUES (${first.command.message.messageId}, 'parent', 'return-continuation', 'user', 'return', 0, ${first.command.createdAt}, ${first.command.createdAt})`;
      h.setParent(shell("parent", "return-continuation", "parent-runtime"));
      const second = completionFixture({
        childThreadId: ThreadId.make("sibling"),
        initialMessageId: MessageId.make("sibling-initial"),
        childTurnId: TurnId.make("sibling-turn"),
        settled: {
          turnId: TurnId.make("sibling-turn"),
          runtimeSessionId: RuntimeSessionId.make("sibling-runtime"),
          observationEpoch: "process-1",
          state: "completed",
          backgroundPending: false,
        },
      });
      yield* h.repo.insert(second);
      h.setChild(shell("sibling", "sibling-turn", "sibling-runtime"));
      const restarted = yield* h.makeWorker;
      yield* restarted.scan(new Date(Date.parse(now) + 6000).toISOString());
      yield* restarted.scan(new Date(Date.parse(now) + 9000).toISOString());
      assert.equal((yield* h.repo.get(second.childThreadId))?.status, "delivered");
      assert.equal(h.sent.length, 2);
      const command = h.sent[1]!;
      if (command.type !== "thread.turn.start") throw new Error("expected queued return");
      assert.equal(command.delegationReturnGuard?.turnId, "return-continuation");
      assert.equal(
        command.delegationReturnGuard?.latestUserMessageId,
        first.command.message.messageId,
      );
      assert.isFalse(
        yield* h.repo.isReturnContinuation(second, TurnId.make("unrelated-user-turn")),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("quarantines one malformed row without starving valid due returns", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.sql`INSERT INTO agent_control_completion_returns (child_thread_id, proposal_id, status, revision, next_check_at, record_json)
    VALUES ('broken', 'broken-proposal', 'waiting', 0, '2000-01-01T00:00:00.000Z', '{bad json')`;
    yield* h.ack();
    yield* h.tick(0);
    yield* h.tick(3);
    assert.equal((yield* h.read()).status, "delivered");
    const rows = yield* h.sql<{
      status: string;
    }>`SELECT status FROM agent_control_completion_returns WHERE child_thread_id = 'broken'`;
    assert.equal(rows[0]?.status, "failed");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "selects the canonical final assistant message even when IDs and timestamps would choose commentary",
  () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('zz-commentary', 'child', 'child-turn', 'assistant', 'wrong commentary', 0, ${now}, ${now})`;
      const output = yield* h.repo.output(ThreadId.make("child"), TurnId.make("child-turn"));
      assert.isTrue(output.text.startsWith("Result "));
      yield* h.sql`UPDATE projection_thread_messages SET is_streaming = 1 WHERE message_id = 'zz-commentary'`;
      yield* h.ack();
      yield* h.tick(0);
      assert.equal((yield* h.read()).status, "waiting");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "queues simultaneously ready siblings while the first return is pending provider turn assignment",
  () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.ack();
      const first = yield* h.read();
      const sibling = {
        ...first,
        revision: 0,
        childThreadId: ThreadId.make("sibling"),
        initialMessageId: MessageId.make("sibling-initial"),
      };
      yield* h.repo.insert(sibling);
      yield* h.tick(0);
      h.modelPendingReturn();
      yield* h.tick(3);
      assert.equal(h.sent.length, 1);
      assert.equal((yield* h.repo.get(sibling.childThreadId))?.status, "ready");
      const delivered = yield* h.read();
      if (delivered.command?.type !== "thread.turn.start") throw new Error("missing command");
      yield* h.sql`UPDATE projection_turns SET turn_id = 'return-turn', state = 'completed'
    WHERE thread_id = 'parent' AND turn_id IS NULL`;
      yield* h.sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
    VALUES (${delivered.command.message.messageId}, 'parent', NULL, 'user', 'return', 0, ${delivered.command.createdAt}, ${delivered.command.createdAt})`;
      h.setParent(shell("parent", "return-turn", "parent-runtime"));
      yield* h.tick(6);
      assert.equal(h.sent.length, 2);
      assert.equal((yield* h.repo.get(sibling.childThreadId))?.status, "delivered");
    }).pipe(Effect.provide(layer)),
);

it.effect("requires completed original dispatch and its exact recorded return authority", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.ack();
    yield* h.sql`UPDATE agent_control_proposals SET status = 'executing' WHERE proposal_id = 'delegation-proposal'`;
    yield* h.tick(0);
    assert.equal((yield* h.read()).status, "waiting");
    yield* h.sql`UPDATE agent_control_proposals SET status = 'completed', principal_json = json_set(principal_json, '$.turnId', 'another-origin')
    WHERE proposal_id = 'delegation-proposal'`;
    yield* h.tick(3);
    assert.equal((yield* h.read()).status, "blocked");
    assert.equal(h.sent.length, 0);
  }).pipe(Effect.provide(layer)),
);

for (const runtime of [null, "replacement-runtime"]) {
  it.effect(`blocks stale idle parent projections when live runtime is ${runtime}`, () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.ack();
      h.setLiveRuntime(runtime);
      yield* h.tick(3);
      assert.strictEqual((yield* h.read()).status, "blocked");
      assert.strictEqual(h.sent.length, 0);
    }).pipe(Effect.provide(layer)),
  );
}
