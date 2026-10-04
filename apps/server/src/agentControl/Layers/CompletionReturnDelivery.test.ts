import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  AgentControlProposal,
  AgentControlProposalId,
  CommandId,
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
  type CompletionReturnRecord,
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
import { AgentControlProposalEventsLive } from "./AgentControlProposalEvents.ts";
import { completionFixture, completionFixtureTime as now } from "../completionReturnTestSupport.ts";
import {
  MAX_WAKE_TEXT_CHARS,
  buildDelegationReturnCommand,
  delegationWakeIds,
  renderCompletionReturn,
  renderDelegationWake,
} from "../completionReturnMessages.ts";
import { makeCompletionReturnDelivery } from "./CompletionReturnDelivery.ts";

import { ProviderService } from "../../provider/Services/ProviderService.ts";

const layer = Layer.mergeAll(
  CompletionReturnRepositoryLive,
  AgentControlProposalRepositoryLive,
  OrchestrationCommandReceiptRepositoryLive,
  AgentControlProposalEventsLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
const DAY = 24 * 60 * 60;
const CHILD_TEXT = "Result ".repeat(1800);

const shell = (
  id: string,
  turn: string,
  runtime: string | null,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  ...Schema.decodeUnknownSync(OrchestrationThreadShell)({
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
    session:
      runtime === null
        ? null
        : {
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
  }),
  ...overrides,
});
const withSession = (
  thread: OrchestrationThreadShell,
  session: Partial<NonNullable<OrchestrationThreadShell["session"]>>,
): OrchestrationThreadShell => ({ ...thread, session: { ...thread.session!, ...session } });

const proposalFor = (proposalId: string, parentThreadId = "parent") =>
  Schema.decodeUnknownSync(AgentControlProposal)({
    proposalId,
    requestId: `request-${proposalId}`,
    principal: {
      kind: "provider-session",
      threadId: parentThreadId,
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

type ApplyMode = "accept" | "reject" | "lost";

const setup = (fixture: Partial<CompletionReturnRecord> = {}) =>
  Effect.gen(function* () {
    const repo = yield* CompletionReturnRepository;
    const sql = yield* SqlClient.SqlClient;
    const proposals = yield* AgentControlProposalRepository;
    const receipts = yield* OrchestrationCommandReceiptRepository;
    const row = completionFixture(fixture);
    yield* repo.insert(row);
    yield* proposals.insert({
      proposal: proposalFor(row.proposalId),
      principalScope: AgentControlPrincipalScope.make("fixture"),
    });
    yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
      VALUES ('parent', 'parent-turn', 'parent-initial', 'completed', ${now}, '[]')`;
    yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('parent-initial', 'parent', NULL, 'user', 'Fixture parent', 0, ${now}, ${now})`;

    const shells = new Map<string, OrchestrationThreadShell | null>();
    // Live provider sessions (ProviderService.getSession); absent = none.
    const live = new Map<string, string>([
      ["parent", "parent-runtime"],
      ["child", "child-runtime"],
    ]);
    let enabled = true;
    let failReads = false;
    let applyMode: ApplyMode = "accept";
    let modelPendingRow = false;
    const sent: Array<Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>> = [];

    // A delegated child with a completed, ingestion-bound initial turn and a final answer.
    const addChild = (
      id: string,
      options: {
        readonly output?: string;
        readonly parent?: string;
        readonly record?: Partial<CompletionReturnRecord>;
      } = {},
    ) =>
      Effect.gen(function* () {
        const record = completionFixture({
          ...fixture,
          childThreadId: ThreadId.make(id),
          initialMessageId: MessageId.make(`${id}-initial`),
          parentThreadId: ThreadId.make(options.parent ?? "parent"),
          ...options.record,
        });
        if (id !== row.childThreadId) yield* repo.insert(record);
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
          VALUES (${id}, ${`${id}-turn`}, ${`${id}-initial`}, ${`${id}-answer`}, 'completed', ${now}, ${now}, ${now}, '[]')`;
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
          VALUES (${`${id}-answer`}, ${id}, ${`${id}-turn`}, 'assistant', ${options.output ?? CHILD_TEXT}, 0, ${now}, ${now})`;
        shells.set(id, shell(id, `${id}-turn`, `${id}-runtime`));
        live.set(id, `${id}-runtime`);
        return record;
      });
    yield* addChild(row.childThreadId);
    shells.set("parent", shell("parent", "parent-turn", "parent-runtime"));

    const makeWorker = makeCompletionReturnDelivery.pipe(
      Effect.provideService(ProviderService, {
        getSession: (threadId: ThreadId) =>
          Effect.sync(() => {
            const runtime = live.get(threadId);
            return runtime === undefined
              ? Option.none()
              : Option.some({ runtimeSessionId: runtime, providerInstanceId: "codex" });
          }),
      } as never),
      Effect.provideService(ProjectionSnapshotQuery, {
        getThreadShellById: (id: ThreadId) =>
          failReads
            ? Effect.fail(new Error("fixture transient"))
            : Effect.succeed(Option.fromNullishOr(shells.get(id))),
      } as never),
      Effect.provideService(OrchestrationCommandApplication, {
        apply: (command: ClientOrchestrationCommand) =>
          Effect.gen(function* () {
            if (command.type !== "thread.turn.start") return yield* Effect.die("unexpected");
            sent.push(command);
            if (applyMode === "lost") return yield* Effect.fail(new Error("lost acknowledgement"));
            yield* receipts.upsert({
              commandId: command.commandId,
              aggregateId: command.threadId,
              aggregateKind: "thread",
              acceptedAt: now,
              resultSequence: 1,
              status: applyMode === "accept" ? "accepted" : "rejected",
              error: applyMode === "accept" ? null : "Delegated result origin changed.",
            });
            if (applyMode === "reject") return yield* Effect.fail(new Error("rejected"));
            if (modelPendingRow)
              yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
                VALUES (${command.threadId}, NULL, ${command.message.messageId}, 'pending', ${command.createdAt}, '[]')`;
            return { sequence: 1 };
          }),
      } as never),
      Effect.provideService(AgentControlPolicy, { isEnabled: Effect.sync(() => enabled) } as never),
    );
    const worker = yield* makeWorker;
    const read = (childThreadId: string = row.childThreadId) =>
      repo.get(ThreadId.make(childThreadId)).pipe(Effect.map((record) => record!));
    const ack = (
      state: "completed" | "error" | "interrupted" = "completed",
      backgroundPending = false,
      epoch = "process-1",
      childThreadId: string = row.childThreadId,
    ) =>
      repo.observe({
        childThreadId: ThreadId.make(childThreadId),
        runtimeSessionId: RuntimeSessionId.make(`${childThreadId}-runtime`),
        observationEpoch: epoch,
        backgroundPending,
        terminal: { turnId: TurnId.make(`${childThreadId}-turn`), state },
      });
    const tick = (seconds: number) => worker.scan(at(seconds));
    let eventSequence = 0;
    const appendEvent = (input: {
      readonly stream: string;
      readonly type: string;
      readonly commandId: string | null;
      readonly actor?: "client" | "provider" | "server";
      readonly occurredAt?: string;
      readonly payload?: Record<string, unknown>;
    }) =>
      Effect.gen(function* () {
        eventSequence += 1;
        yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${eventSequence}`}, 'thread', ${input.stream}, ${eventSequence}, ${input.type}, ${input.occurredAt ?? at(1)},
            ${input.commandId}, NULL, NULL, ${input.actor ?? "client"}, ${JSON.stringify({ threadId: input.stream, ...input.payload })}, '{}')`;
      });
    const appendStartFailure = (threadId: string, messageId: string) =>
      sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
        VALUES (${`failure-${threadId}-${messageId}`}, ${threadId}, 'error', 'provider.turn.start.failed', 'Provider turn start failed', ${JSON.stringify({ messageId })}, ${now})`;
    return {
      row,
      repo,
      sql,
      read,
      ack,
      tick,
      makeWorker,
      receipts,
      proposals,
      sent,
      addChild,
      appendEvent,
      appendStartFailure,
      shells,
      live,
      setParent: (value: OrchestrationThreadShell | null) => {
        shells.set("parent", value);
      },
      setChild: (value: OrchestrationThreadShell | null, id: string = row.childThreadId) => {
        shells.set(id, value);
      },
      setEnabled: (value: boolean) => {
        enabled = value;
      },
      failReads: (value: boolean) => {
        failReads = value;
      },
      applyMode: (value: ApplyMode) => {
        applyMode = value;
      },
      modelPendingRow: () => {
        modelPendingRow = true;
      },
    };
  });

const busyParent = () =>
  withSession(shell("parent", "parent-turn", "parent-runtime"), {
    status: "running",
    activeTurnId: TurnId.make("parent-turn"),
  });

// ── delivery and batching ────────────────────────────────────────────────

it.effect(
  "waits for authoritative completion, background settlement and parent idle; dispatches once with bounded attribution",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.tick(0);
      assert.equal((yield* h.read()).status, "waiting");
      yield* h.ack("completed", true);
      yield* h.tick(3);
      assert.equal(h.sent.length, 0);
      yield* h.ack("completed", false);
      h.setParent(busyParent());
      yield* h.tick(6);
      assert.equal((yield* h.read()).status, "ready");
      yield* h.tick(9);
      assert.equal(h.sent.length, 0);
      assert.include((yield* h.read()).detail, "idle");
      h.setParent(shell("parent", "parent-turn", "parent-runtime"));
      yield* h.tick(12);
      assert.equal((yield* h.read()).status, "delivered");
      const restarted = yield* h.makeWorker;
      yield* restarted.scan(at(18));
      assert.equal(h.sent.length, 1);
      const command = h.sent[0]!;
      assert.include(command.message.text, "Ryco delegation update (automatic message");
      assert.include(command.message.text, '"truncated":true');
      assert.include(command.message.text, "Untrusted child output");
      assert.include(command.message.text, "/ryco/thread/parent");
      assert.isBelow(command.message.text.length, 12000);
      assert.deepStrictEqual(command.delegationReturnGuard, {
        latestUserMessageId: MessageId.make("parent-initial"),
        projectId: h.row.projectId,
        runtimeMode: "approval-required",
        worktreePath: null,
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("T1 batches siblings that become ready together into one parent wake", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.addChild("child-3");
    yield* h.addChild("child-2");
    h.setParent(busyParent());
    for (const id of ["child", "child-2", "child-3"]) yield* h.ack("completed", false, "p", id);
    yield* h.tick(0);
    assert.equal(h.sent.length, 0);
    h.setParent(shell("parent", "parent-turn", "parent-runtime"));
    yield* h.tick(3);
    assert.equal(h.sent.length, 1);
    const command = h.sent[0]!;
    assert.equal(command.commandId, delegationWakeIds(ThreadId.make("child"), 0).commandId);
    assert.equal(command.commandId, "delegation-return:child");
    assert.equal(command.message.messageId, "delegation-result:child");
    assert.equal(command.message.text.split("Untrusted child output").length - 1, 3);
    assert.include(command.message.text, "[3/3]");
    for (const id of ["child", "child-2", "child-3"]) {
      const record = yield* h.read(id);
      assert.equal(record.status, "delivered");
      assert.include(record.detail, "batched with 2 other task(s)");
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("T2 holds a sibling captured while the wake is pending, then sends a second wake", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.addChild("child-2");
    h.modelPendingRow();
    yield* h.ack();
    yield* h.tick(0);
    assert.equal(h.sent.length, 1);
    yield* h.ack("completed", false, "p", "child-2");
    yield* h.tick(3);
    yield* h.tick(6);
    assert.equal(h.sent.length, 1);
    assert.equal((yield* h.read("child-2")).status, "ready");
    yield* h.sql`UPDATE projection_turns SET turn_id = 'wake-turn', state = 'completed'
      WHERE thread_id = 'parent' AND turn_id IS NULL`;
    yield* h.tick(9);
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[1]!.commandId, "delegation-return:child-2");
    assert.include(h.sent[1]!.message.text, "[1/1]");
    assert.equal((yield* h.read("child-2")).status, "delivered");
  }).pipe(Effect.provide(layer)),
);

it.effect("T3 delivers after the parent advanced to an unrelated user turn", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    h.setParent(shell("parent", "unrelated-user-turn", "parent-runtime"));
    yield* h.ack();
    yield* h.tick(0);
    assert.equal((yield* h.read()).status, "delivered");
    assert.equal(h.sent.length, 1);
  }).pipe(Effect.provide(layer)),
);

for (const scenario of ["no-live-session", "replacement-runtime", "reaped", "restart-error"]) {
  it.effect(`T4 is restart-safe: ${scenario}`, () =>
    Effect.gen(function* () {
      const h = yield* setup();
      if (scenario === "no-live-session") h.live.delete("parent");
      if (scenario === "replacement-runtime") {
        h.live.set("parent", "replacement-runtime");
        h.setParent(shell("parent", "parent-turn", "replacement-runtime"));
      }
      if (scenario === "reaped")
        h.setParent(
          withSession(shell("parent", "parent-turn", "parent-runtime"), { status: "stopped" }),
        );
      if (scenario === "restart-error")
        h.setParent(
          withSession(shell("parent", "parent-turn", "parent-runtime"), { status: "error" }),
        );
      yield* h.ack();
      yield* h.tick(0);
      assert.equal((yield* h.read()).status, "delivered");
      const guard = h.sent[0]!.delegationReturnGuard!;
      assert.notProperty(guard, "runtimeSessionId");
      assert.notProperty(guard, "turnId");
      assert.notProperty(guard, "turnMessageId");
      assert.notProperty(guard, "providerInstanceId");
    }).pipe(Effect.provide(layer)),
  );
}

it.effect("T5 throttles cold wakes to one in flight; warm parents are not throttled", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    // The fixture child stays waiting; ready rows for three cold parents and one warm one.
    for (const parent of ["p1", "p2", "p3", "p4"]) {
      h.shells.set(parent, shell(parent, `${parent}-turn`, null));
      yield* h.repo.insert(
        completionFixture({
          childThreadId: ThreadId.make(`${parent}-child`),
          initialMessageId: MessageId.make(`${parent}-child-initial`),
          parentThreadId: ThreadId.make(parent),
          status: "ready",
          capture: {
            kind: "result",
            outcome: "completed",
            capturedAt: now,
            section: `Section for ${parent}`,
          },
        }),
      );
    }
    h.shells.set("p4", shell("p4", "p4-turn", "p4-runtime"));
    yield* h.tick(0);
    // p1 goes cold; p2/p3 wait; p4 is warm and was held back only by this scan's order.
    const parentsOf = () => h.sent.map((command) => command.threadId as string);
    assert.deepStrictEqual(parentsOf(), ["p1"]);
    h.live.set("p4", "p4-runtime");
    yield* h.tick(3);
    assert.deepStrictEqual(parentsOf(), ["p1", "p4"]);
    yield* h.sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
      VALUES ('p1', 'p1-wake', ${h.sent[0]!.message.messageId}, 'running', ${at(4)}, '[]')`;
    yield* h.tick(6);
    assert.deepStrictEqual(parentsOf(), ["p1", "p4", "p2"]);
    yield* h.tick(9);
    assert.deepStrictEqual(parentsOf(), ["p1", "p4", "p2"]);
    assert.include((yield* h.read("p3-child")).detail, "another chat's session");
    yield* h.tick(6 + 121);
    assert.deepStrictEqual(parentsOf(), ["p1", "p4", "p2", "p3"]);
  }).pipe(Effect.provide(layer)),
);

// ── user stop ────────────────────────────────────────────────────────────

for (const stop of ["a", "b", "c", "d", "e", "f"] as const) {
  it.effect(`T6${stop} attributes user stops of the orchestration by event order`, () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const wakeStart = (occurredAt: string) =>
        h.appendEvent({
          stream: "parent",
          type: "thread.turn-start-requested",
          commandId: "delegation-return:earlier-sibling",
          occurredAt,
          payload: { messageId: "delegation-result:earlier-sibling" },
        });
      const clientStop = (commandId: string | null, payload: Record<string, unknown> = {}) =>
        h.appendEvent({
          stream: "parent",
          type: "thread.turn-interrupt-requested",
          commandId,
          payload,
        });
      if (stop === "a") {
        yield* wakeStart(at(1));
        yield* clientStop("web:stop");
      }
      if (stop === "b") {
        yield* h.appendEvent({
          stream: "parent",
          type: "thread.turn-start-requested",
          commandId: "web:send",
          payload: { messageId: "parent-initial" },
        });
        yield* clientStop("web:stop", { turnId: "parent-turn" });
      }
      if (stop === "c") {
        yield* wakeStart(at(1));
        yield* clientStop("agent-control:op:turn-interrupt");
      }
      if (stop === "d") {
        yield* wakeStart(at(1));
        yield* h.appendEvent({
          stream: "parent",
          type: "thread.turn-interrupt-requested",
          commandId: "provider:startup-reconciliation:parent",
          actor: "provider",
        });
      }
      if (stop === "e") {
        yield* wakeStart(at(-60));
        yield* clientStop("web:stop");
      }
      if (stop === "f") {
        yield* h.appendEvent({
          stream: "parent",
          type: "thread.turn-start-requested",
          commandId: "web:send",
          payload: { messageId: "unrelated-user-message" },
        });
        yield* clientStop("web:stop");
      }
      yield* h.ack();
      yield* h.tick(3);
      if (stop === "a" || stop === "b") {
        assert.equal((yield* h.read()).status, "cancelled");
        assert.include((yield* h.read()).detail, "You stopped the delegating chat");
        assert.equal(h.sent.length, 0);
      } else {
        assert.equal((yield* h.read()).status, "delivered");
        assert.equal(h.sent.length, 1);
      }
    }).pipe(Effect.provide(layer)),
  );
}

// ── notices ──────────────────────────────────────────────────────────────

for (const outcome of [
  "interrupted",
  "stopped",
  "start-failed",
  "advanced",
  "archived",
  "deleted",
  "request-failed",
  "expired",
] as const) {
  it.effect(`T7 wakes the parent with a ${outcome} notice and no child text`, () =>
    Effect.gen(function* () {
      const h = yield* setup();
      let seconds = 0;
      if (outcome === "interrupted") yield* h.ack("interrupted");
      if (outcome === "stopped") {
        // Startup reconciliation interrupted the running child; ingestion never acked.
        h.setChild(withSession(shell("child", "child-turn", "child-runtime"), { status: "error" }));
        yield* h.sql`UPDATE projection_turns SET state = 'interrupted' WHERE thread_id = 'child'`;
      }
      if (outcome === "start-failed") yield* h.appendStartFailure("child", "child-initial");
      if (outcome === "advanced") {
        yield* h.ack();
        yield* h.sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
          VALUES ('child', 'follow-up-turn', 'user-follow-up', 'completed', ${now}, '[]')`;
        h.setChild(shell("child", "follow-up-turn", "child-runtime"));
      }
      if (outcome === "archived")
        h.setChild({ ...shell("child", "child-turn", "child-runtime"), archivedAt: now });
      if (outcome === "deleted") h.setChild(null);
      if (outcome === "request-failed")
        yield* h.sql`UPDATE agent_control_proposals SET status = 'failed' WHERE proposal_id = 'delegation-proposal'`;
      if (outcome === "expired") seconds = DAY + 1;
      yield* h.tick(seconds);
      assert.equal((yield* h.read()).status, "delivered");
      assert.equal(h.sent.length, 1);
      const text = h.sent[0]!.message.text;
      assert.include(
        text,
        `Delegated task notice (${outcome === "deleted" ? "archived" : outcome}).`,
      );
      assert.notInclude(text, "Result Result");
      assert.include((yield* h.read()).detail, "Notice");
    }).pipe(Effect.provide(layer)),
  );
}

it.effect("keeps a failed initial run a result with the error flag", () =>
  Effect.gen(function* () {
    const h = yield* setup();
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
    assert.equal((yield* h.read()).status, "delivered");
    assert.include(h.sent[0]!.message.text, "initial child run failed");
    assert.include(h.sent[0]!.message.text, "Result Result");
  }).pipe(Effect.provide(layer)),
);

// ── parent side, caps and scope ──────────────────────────────────────────

for (const boundary of ["archived", "deleted", "worktree-archived", "owner-cancel"] as const) {
  it.effect(`T8 cancels without a wake when the parent side ends: ${boundary}`, () =>
    Effect.gen(function* () {
      const h = yield* setup();
      if (boundary === "archived")
        h.setParent({ ...shell("parent", "parent-turn", "parent-runtime"), archivedAt: now });
      if (boundary === "deleted") h.setParent(null);
      if (boundary === "worktree-archived") {
        h.setParent({
          ...shell("parent", "parent-turn", "parent-runtime"),
          worktreeId: "worktree-1" as never,
        });
        yield* h.sql`INSERT INTO projection_worktrees (worktree_id, project_id, branch, worktree_path, origin, created_at, updated_at, archived_at)
          VALUES ('worktree-1', 'project-1', 'feature', '/tmp/worktree-1', 'branch', ${now}, ${now}, ${now})`;
      }
      if (boundary === "owner-cancel") {
        const cancelled = yield* h.repo.cancelOwned({
          childThreadId: ThreadId.make("child"),
          parentThreadId: ThreadId.make("parent"),
          detail: "Cancelled by the delegating chat with ryco_task_cancel.",
          now,
        });
        assert.equal(cancelled?.status, "cancelled");
        yield* h.ack("interrupted");
      } else {
        yield* h.ack();
      }
      yield* h.tick(0);
      yield* h.tick(3);
      assert.equal((yield* h.read()).status, "cancelled");
      assert.equal(h.sent.length, 0);
    }).pipe(Effect.provide(layer)),
  );
}

it.effect("T9 caps a wake by text size and by section count", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    // Each control character escapes to six JSON characters. NUL itself does not survive the
    // SQLite TEXT round trip the child output takes, so use U+0001.
    const hostile = "\u0001".repeat(9000);
    yield* h.sql`UPDATE projection_thread_messages SET text = ${hostile} WHERE message_id = 'child-answer'`;
    yield* h.addChild("child-2", { output: hostile });
    yield* h.addChild("child-3", { output: hostile });
    for (const id of ["child", "child-2", "child-3"]) yield* h.ack("completed", false, "p", id);
    yield* h.tick(0);
    yield* h.tick(3);
    assert.equal(h.sent.length, 2);
    const sections = yield* Effect.forEach(["child", "child-2", "child-3"], (id) =>
      h.read(id).pipe(Effect.map((record) => renderCompletionReturn(record, hostile))),
    );
    assert.isAbove(renderDelegationWake(sections).length, MAX_WAKE_TEXT_CHARS);
    assert.equal(h.sent[0]!.message.text, renderDelegationWake(sections.slice(0, 2)));
    assert.isAtMost(h.sent[0]!.message.text.length, MAX_WAKE_TEXT_CHARS);
    assert.equal(h.sent[1]!.message.text, renderDelegationWake(sections.slice(2)));
  }).pipe(Effect.provide(layer)),
);

it.effect("T9 caps a wake at ten sections", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const ids = Array.from(
      { length: 11 },
      (_, index) => `child-${String(index + 2).padStart(2, "0")}`,
    );
    for (const id of ids) yield* h.addChild(id, { output: "short" });
    for (const id of ["child", ...ids]) yield* h.ack("completed", false, "p", id);
    yield* h.tick(0);
    yield* h.tick(3);
    assert.equal(h.sent.length, 2);
    assert.include(h.sent[0]!.message.text, "[10/10]");
    assert.include(h.sent[1]!.message.text, "[2/2]");
  }).pipe(Effect.provide(layer)),
);

it.effect("T12 holds out-of-scope or disabled delivery and expires it 24 hours after capture", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.ack();
    h.setParent({
      ...shell("parent", "parent-turn", "parent-runtime"),
      runtimeMode: "full-access",
    });
    yield* h.tick(0);
    assert.equal((yield* h.read()).status, "ready");
    assert.include((yield* h.read()).detail, "permissions or workspace changed");
    h.setParent({
      ...shell("parent", "parent-turn", "parent-runtime"),
      worktreePath: "/elsewhere",
    });
    yield* h.tick(3);
    assert.include((yield* h.read()).detail, "permissions or workspace changed");
    h.setParent(shell("parent", "parent-turn", "parent-runtime"));
    h.setEnabled(false);
    yield* h.tick(6);
    assert.equal((yield* h.read()).status, "ready");
    assert.include((yield* h.read()).detail, "Agent Control is disabled");
    assert.equal(h.sent.length, 0);
    h.setEnabled(true);
    yield* h.tick(9);
    assert.equal((yield* h.read()).status, "delivered");
  }).pipe(Effect.provide(layer)),
);

it.effect("T12 delivers when the parent's runtime was lowered", () =>
  Effect.gen(function* () {
    const h = yield* setup({ parentRuntimeMode: "full-access" });
    yield* h.ack();
    yield* h.tick(0);
    assert.equal((yield* h.read()).status, "delivered");
  }).pipe(Effect.provide(layer)),
);

it.effect("T12 fails a return held out of scope for 24 hours without a wake", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.ack();
    h.setParent({
      ...shell("parent", "parent-turn", "parent-runtime"),
      runtimeMode: "full-access",
    });
    yield* h.tick(0);
    yield* h.tick(DAY + 1);
    assert.equal((yield* h.read()).status, "failed");
    assert.include((yield* h.read()).detail, "Not delivered within 24 hours");
    assert.equal(h.sent.length, 0);
  }).pipe(Effect.provide(layer)),
);

// ── dispatch recovery ────────────────────────────────────────────────────

it.effect("T10 replays a claimed batch with the same ids after a lost dispatch", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.ack();
    h.applyMode("lost");
    yield* h.tick(0);
    assert.equal((yield* h.read()).status, "dispatching");
    h.applyMode("accept");
    const restarted = yield* h.makeWorker;
    yield* restarted.scan(at(3));
    assert.equal((yield* h.read()).status, "delivered");
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[1]!.commandId, h.sent[0]!.commandId);
    assert.equal(h.sent[1]!.message.messageId, h.sent[0]!.message.messageId);
  }).pipe(Effect.provide(layer)),
);

it.effect("T10 ends uncertain after two replays without a receipt", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.ack();
    h.applyMode("lost");
    yield* h.tick(0);
    yield* h.tick(3);
    assert.equal((yield* h.read()).status, "dispatching");
    yield* h.tick(6);
    assert.equal((yield* h.read()).status, "uncertain");
    assert.include((yield* h.read()).detail, "Check the parent");
    yield* h.tick(9);
    assert.equal(h.sent.length, 3);
  }).pipe(Effect.provide(layer)),
);

it.effect("T11 retries a rejected wake with a new attempt id and blocks after five", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.ack();
    h.applyMode("reject");
    yield* h.tick(0);
    const afterFirst = yield* h.read();
    assert.equal(afterFirst.status, "ready");
    assert.equal(afterFirst.deliveryAttempts, 1);
    for (const seconds of [3, 6, 9, 12]) yield* h.tick(seconds);
    assert.deepStrictEqual(
      h.sent.map((command) => command.commandId),
      [
        "delegation-return:child",
        "delegation-return:child:1",
        "delegation-return:child:2",
        "delegation-return:child:3",
        "delegation-return:child:4",
      ],
    );
    assert.equal((yield* h.read()).status, "blocked");
    assert.include((yield* h.read()).detail, "rejected repeatedly");
  }).pipe(Effect.provide(layer)),
);

// ── legacy rows, pending starts, background and nesting ──────────────────

it.effect("T13 delivers a legacy ready row through a minimal-guard wake", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const current = yield* h.read();
    yield* h.repo.save(current, {
      ...current,
      status: "ready",
      command: {
        type: "thread.turn.start",
        commandId: CommandId.make("delegation-return:child"),
        threadId: ThreadId.make("parent"),
        delegationReturnGuard: {
          turnMessageId: MessageId.make("parent-initial"),
          latestUserMessageId: MessageId.make("parent-initial"),
          projectId: current.projectId,
          turnId: TurnId.make("parent-turn"),
          runtimeSessionId: RuntimeSessionId.make("parent-runtime"),
          providerInstanceId: current.parentProviderInstanceId,
          runtimeMode: "approval-required",
          worktreePath: null,
        },
        message: {
          messageId: MessageId.make("delegation-result:child"),
          role: "user",
          text: "LEGACY SECTION",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: now,
      },
    });
    yield* h.tick(0);
    assert.equal((yield* h.read()).status, "delivered");
    assert.include(h.sent[0]!.message.text, "[1/1]\nLEGACY SECTION");
    assert.notProperty(h.sent[0]!.delegationReturnGuard!, "turnId");
  }).pipe(Effect.provide(layer)),
);

it.effect("T13 settles a legacy dispatching row against its existing receipt", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const current = yield* h.read();
    yield* h.repo.save(current, {
      ...current,
      status: "dispatching",
      command: {
        type: "thread.turn.start",
        commandId: CommandId.make("delegation-return:child"),
        threadId: ThreadId.make("parent"),
        message: {
          messageId: MessageId.make("delegation-result:child"),
          role: "user",
          text: "LEGACY SECTION",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: now,
      },
    });
    yield* h.receipts.upsert({
      commandId: CommandId.make("delegation-return:child"),
      aggregateKind: "thread",
      aggregateId: ThreadId.make("parent"),
      acceptedAt: now,
      resultSequence: 2,
      status: "accepted",
      error: null,
    });
    h.setParent(shell("parent", "newer", "different-runtime"));
    const reopened = yield* makeCompletionReturnRepository;
    assert.equal((yield* reopened.get(current.childThreadId))?.status, "dispatching");
    const restarted = yield* h.makeWorker;
    yield* restarted.scan(at(3));
    assert.equal((yield* h.read()).status, "delivered");
    assert.equal(h.sent.length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("T14 holds behind an observed pending start for the grace, measured by scan time", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
      VALUES ('parent', NULL, 'user-pending', 'pending', ${now}, '[]')`;
    yield* h.ack();
    yield* h.tick(0);
    assert.equal((yield* h.read()).status, "ready");
    yield* h.tick(60);
    assert.equal(h.sent.length, 0);
    yield* h.tick(120);
    assert.equal((yield* h.read()).status, "delivered");
  }).pipe(Effect.provide(layer)),
);

it.effect("T14 ignores a pending start that already failed", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
      VALUES ('parent', NULL, 'user-pending', 'pending', ${now}, '[]')`;
    yield* h.appendStartFailure("parent", "user-pending");
    yield* h.ack();
    yield* h.tick(0);
    assert.equal((yield* h.read()).status, "delivered");
  }).pipe(Effect.provide(layer)),
);

it.effect("T15 captures pending background work once the child's session is gone", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.ack("completed", true);
    yield* h.tick(0);
    assert.equal((yield* h.read()).status, "waiting");
    h.live.delete("child");
    yield* h.tick(3);
    assert.equal((yield* h.read()).status, "delivered");
    assert.include(h.sent[0]!.message.text, '"backgroundEnded"');
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "retries transient reads, but never interprets a new process's empty background registry as settled",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      h.failReads(true);
      yield* h.tick(0);
      assert.include((yield* h.read()).detail, "retrying");
      h.failReads(false);
      yield* h.ack("completed", true);
      yield* h.ack("completed", false, "process-2");
      yield* h.tick(3);
      assert.equal((yield* h.read()).status, "waiting");
      // The live child session still owns unsettled background work: expire as a notice.
      yield* h.tick(DAY + 1);
      assert.equal((yield* h.read()).status, "delivered");
      assert.include(h.sent[0]!.message.text, "Delegated task notice (expired).");
      assert.notInclude(h.sent[0]!.message.text, "Result Result");
    }).pipe(Effect.provide(layer)),
);

it.effect("T16 returns a nested child's output after its own delegation wake", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.ack();
    // The child delegated a grandchild and ended its turn ("I delegated").
    const grandchild = completionFixture({
      childThreadId: ThreadId.make("grandchild"),
      initialMessageId: MessageId.make("grandchild-initial"),
      parentThreadId: ThreadId.make("child"),
      proposalId: AgentControlProposalId.make("nested-proposal"),
      nextCheckAt: at(DAY * 30),
    });
    yield* h.repo.insert(grandchild);
    yield* h.tick(0);
    assert.equal((yield* h.read()).status, "waiting");
    assert.include((yield* h.read()).detail, "own delegated work");
    // The grandchild's wake was delivered to the child and is running there.
    const stored = (yield* h.read("grandchild"))!;
    yield* h.repo.save(stored, { ...stored, status: "delivered" });
    yield* h.sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, checkpoint_files_json)
      VALUES ('child', 'child-wake-turn', 'delegation-result:grandchild', 'child-final', 'completed', ${now}, '[]')`;
    yield* h.sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('child-final', 'child', 'child-wake-turn', 'assistant', 'Final child answer', 0, ${now}, ${now})`;
    h.setChild(shell("child", "child-wake-turn", "child-runtime"));
    yield* h.tick(3);
    assert.equal(h.sent.length, 0);
    yield* h.repo.observe({
      childThreadId: ThreadId.make("child"),
      runtimeSessionId: RuntimeSessionId.make("child-runtime"),
      observationEpoch: "process-1",
      backgroundPending: false,
      terminal: { turnId: TurnId.make("child-wake-turn"), state: "completed" },
    });
    assert.equal((yield* h.read()).delegationWakeTurns, 1);
    yield* h.tick(6);
    assert.equal((yield* h.read()).status, "delivered");
    assert.include(h.sent[0]!.message.text, "after 1 delegation update(s)");
    assert.include(h.sent[0]!.message.text, "Final child answer");
    assert.notInclude(h.sent[0]!.message.text, "Result Result");
  }).pipe(Effect.provide(layer)),
);

// ── review regressions ───────────────────────────────────────────────────

const RESULT_CAPTURE = {
  kind: "result",
  outcome: "completed",
  capturedAt: now,
  section: "Captured section",
} as const;

it.effect("T6g counts a stop of the delegating turn pressed before the child existed", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    // The delegating turn starts, the user stops it while the (approval-gated) request is
    // pending, and only then is the child created.
    yield* h.appendEvent({
      stream: "parent",
      type: "thread.turn-start-requested",
      commandId: "web:send",
      payload: { messageId: "parent-initial" },
    });
    yield* h.appendEvent({
      stream: "parent",
      type: "thread.turn-interrupt-requested",
      commandId: "web:stop",
    });
    yield* h.appendEvent({
      stream: "child",
      type: "thread.created",
      commandId: "agent-control:create",
    });
    yield* h.ack();
    yield* h.tick(3);
    const record = yield* h.read();
    assert.equal(record.status, "cancelled");
    assert.include(record.detail, "You stopped the delegating chat");
    // The persisted scan bound is the delegating turn's own start, not the child's first event.
    assert.equal(record.sinceSequence, 1);
    assert.equal(h.sent.length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("T6h finds a stop of a wake behind more than fifty unrelated stops", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    for (let index = 0; index < 60; index += 1) {
      yield* h.appendEvent({
        stream: "parent",
        type: "thread.turn-start-requested",
        commandId: "web:send",
        payload: { messageId: `unrelated-${index}` },
      });
      yield* h.appendEvent({
        stream: "parent",
        type: "thread.turn-interrupt-requested",
        commandId: "web:stop",
      });
    }
    yield* h.appendEvent({
      stream: "parent",
      type: "thread.turn-start-requested",
      commandId: "delegation-return:earlier-sibling",
      payload: { messageId: "delegation-result:earlier-sibling" },
    });
    yield* h.appendEvent({
      stream: "parent",
      type: "thread.turn-interrupt-requested",
      commandId: "web:stop",
    });
    yield* h.ack();
    yield* h.tick(3);
    assert.equal((yield* h.read()).status, "cancelled");
    assert.equal(h.sent.length, 0);
  }).pipe(Effect.provide(layer)),
);

/** Leave `rows` claimed into one batch whose apply never happened (a crash before it). */
const claimLost = (
  h: Effect.Success<ReturnType<typeof setup>>,
  parent: OrchestrationThreadShell,
  rows: ReadonlyArray<CompletionReturnRecord>,
  dispatchedAt: string,
  cold: boolean,
) =>
  Effect.gen(function* () {
    const anchor = rows.map((row) => row.childThreadId).toSorted()[0]!;
    const command = buildDelegationReturnCommand({
      parent,
      latestUserMessageId: null,
      sections: rows.map(() => RESULT_CAPTURE.section),
      anchorChildThreadId: anchor,
      attempt: 0,
      now: dispatchedAt,
    });
    for (const row of rows) {
      const claimed: CompletionReturnRecord = {
        ...row,
        status: "dispatching",
        capture: RESULT_CAPTURE,
        command: row.childThreadId === anchor ? command : null,
        batch: {
          commandId: command.commandId,
          messageId: command.message.messageId,
          anchorChildThreadId: anchor,
          childThreadIds: rows.map((member) => member.childThreadId),
          attempt: 0,
          replays: 0,
          dispatchedAt,
          cold,
        },
      };
      const stored = yield* h.repo.get(row.childThreadId);
      if (stored) yield* h.repo.save(stored, claimed);
      else yield* h.repo.insert(claimed);
    }
    return command;
  });

it.effect("T10 replays count against the cold budget and start the grace at the replay", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const lost: Array<{ readonly commandId: CommandId }> = [];
    for (const parent of ["p1", "p2"]) {
      h.shells.set(parent, shell(parent, `${parent}-turn`, null));
      const row = completionFixture({
        childThreadId: ThreadId.make(`${parent}-child`),
        initialMessageId: MessageId.make(`${parent}-child-initial`),
        parentThreadId: ThreadId.make(parent),
      });
      lost.push(yield* claimLost(h, h.shells.get(parent)!, [row], at(-300), true));
    }
    // A restarted worker finds both cold batches without receipts.
    const restarted = yield* h.makeWorker;
    yield* restarted.scan(at(0));
    assert.deepStrictEqual(
      h.sent.map((command) => command.commandId),
      [lost[0]!.commandId],
    );
    assert.include((yield* h.read("p2-child")).detail, "another chat's session");
    // The slot's grace runs from the replay, not from the original claim 300 s earlier.
    yield* restarted.scan(at(3));
    assert.equal(h.sent.length, 1);
    yield* restarted.scan(at(121));
    assert.deepStrictEqual(
      h.sent.map((command) => command.commandId),
      [lost[0]!.commandId, lost[1]!.commandId],
    );
    assert.equal((yield* h.read("p2-child")).status, "delivered");
  }).pipe(Effect.provide(layer)),
);

it.effect("T10 never replays a claimed wake the user stopped meanwhile", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* claimLost(h, h.shells.get("parent")!, [yield* h.read()], at(0), false);
    yield* h.appendEvent({
      stream: "parent",
      type: "thread.turn-start-requested",
      commandId: "web:send",
      payload: { messageId: "parent-initial" },
    });
    yield* h.appendEvent({
      stream: "parent",
      type: "thread.turn-interrupt-requested",
      commandId: "web:stop",
    });
    const restarted = yield* h.makeWorker;
    yield* restarted.scan(at(3));
    assert.equal((yield* h.read()).status, "cancelled");
    assert.include((yield* h.read()).detail, "You stopped the delegating chat");
    assert.equal(h.sent.length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "T10 releases an out-of-scope claimed wake to the scope hold instead of replaying it",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* claimLost(h, h.shells.get("parent")!, [yield* h.read()], at(0), false);
      h.setParent({
        ...shell("parent", "parent-turn", "parent-runtime"),
        runtimeMode: "full-access",
      });
      const restarted = yield* h.makeWorker;
      yield* restarted.scan(at(3));
      assert.equal((yield* h.read()).status, "ready");
      assert.equal(h.sent.length, 0);
      yield* restarted.scan(at(6));
      assert.include((yield* h.read()).detail, "permissions or workspace changed");
      h.setParent(shell("parent", "parent-turn", "parent-runtime"));
      yield* restarted.scan(at(9));
      assert.equal((yield* h.read()).status, "delivered");
      assert.equal(h.sent.length, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect("T11 blocks only the rows that were themselves rejected five times", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.addChild("child-2");
    const veteran = yield* h.read();
    yield* h.repo.save(veteran, {
      ...veteran,
      status: "ready",
      capture: RESULT_CAPTURE,
      deliveryAttempts: 4,
      rejections: 4,
    });
    const fresh = yield* h.read("child-2");
    yield* h.repo.save(fresh, { ...fresh, status: "ready", capture: RESULT_CAPTURE });
    h.applyMode("reject");
    yield* h.tick(0);
    assert.equal(h.sent[0]!.commandId, "delegation-return:child:4");
    assert.equal((yield* h.read()).status, "blocked");
    const survivor = yield* h.read("child-2");
    assert.equal(survivor.status, "ready");
    assert.equal(survivor.rejections, 1);
    assert.equal(survivor.deliveryAttempts, 5);
    h.applyMode("accept");
    yield* h.tick(3);
    assert.equal(h.sent[1]!.commandId, "delegation-return:child-2:5");
    assert.equal((yield* h.read("child-2")).status, "delivered");
  }).pipe(Effect.provide(layer)),
);

/** The child delegated a grandchild whose result was already delivered to it in a wake. */
const deliveredOwnWake = (h: Effect.Success<ReturnType<typeof setup>>) =>
  h.repo.insert(
    completionFixture({
      childThreadId: ThreadId.make("grandchild"),
      initialMessageId: MessageId.make("grandchild-initial"),
      parentThreadId: ThreadId.make("child"),
      proposalId: AgentControlProposalId.make("nested-proposal"),
      status: "delivered",
      capture: RESULT_CAPTURE,
      batch: {
        commandId: CommandId.make("delegation-return:grandchild"),
        messageId: MessageId.make("delegation-result:grandchild"),
        anchorChildThreadId: ThreadId.make("grandchild"),
        childThreadIds: [ThreadId.make("grandchild")],
        attempt: 0,
        replays: 0,
        dispatchedAt: now,
        cold: false,
      },
    }),
  );

it.effect("T16 sends a stopped notice when the child's own wake ended at a restart", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.ack();
    yield* deliveredOwnWake(h);
    // Startup reconciliation interrupted the child's wake turn; ingestion never observed it.
    yield* h.sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
      VALUES ('child', 'child-wake-turn', 'delegation-result:grandchild', 'interrupted', ${now}, '[]')`;
    h.setChild(
      withSession(shell("child", "child-wake-turn", "child-runtime"), { status: "error" }),
    );
    yield* h.tick(0);
    assert.equal((yield* h.read()).status, "waiting");
    assert.include((yield* h.read()).detail, "own delegated work");
    h.live.delete("child");
    yield* h.tick(3);
    assert.equal((yield* h.read()).status, "delivered");
    assert.include(h.sent[0]!.message.text, "Delegated task notice (stopped).");
    assert.notInclude(h.sent[0]!.message.text, "Result Result");
  }).pipe(Effect.provide(layer)),
);

it.effect("T16 sends a stopped notice when the child's own wake failed to start", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.ack();
    yield* deliveredOwnWake(h);
    yield* h.sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
      VALUES ('child', NULL, 'delegation-result:grandchild', 'pending', ${now}, '[]')`;
    yield* h.appendStartFailure("child", "delegation-result:grandchild");
    yield* h.tick(0);
    assert.equal((yield* h.read()).status, "delivered");
    assert.include(h.sent[0]!.message.text, "Delegated task notice (stopped).");
    // Never the child's "I delegated" output from before its wake.
    assert.notInclude(h.sent[0]!.message.text, "Result Result");
  }).pipe(Effect.provide(layer)),
);

it.effect("T16 stops waiting for the child's own wake that never bound after the grace", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.ack();
    yield* deliveredOwnWake(h);
    // Accepted, but the reactor work that would start it died with the old process.
    yield* h.sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
      VALUES ('child', NULL, 'delegation-result:grandchild', 'pending', ${now}, '[]')`;
    yield* h.tick(0);
    yield* h.tick(121);
    // A live child session may still be starting the wake.
    assert.equal((yield* h.read()).status, "waiting");
    assert.include((yield* h.read()).detail, "own delegated work");
    h.live.delete("child");
    yield* h.tick(124);
    assert.equal((yield* h.read()).status, "delivered");
    assert.include(h.sent[0]!.message.text, "Delegated task notice (stopped).");
  }).pipe(Effect.provide(layer)),
);

it.effect("T16 sends an advanced notice for a follow-up hidden behind the child's own wake", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.ack();
    const grandchild = completionFixture({
      childThreadId: ThreadId.make("grandchild"),
      initialMessageId: MessageId.make("grandchild-initial"),
      parentThreadId: ThreadId.make("child"),
      proposalId: AgentControlProposalId.make("nested-proposal"),
      nextCheckAt: at(DAY * 30),
    });
    yield* h.repo.insert(grandchild);
    yield* h.tick(0);
    assert.include((yield* h.read()).detail, "own delegated work");
    // Someone sends the child a follow-up; then the grandchild's wake runs after it.
    yield* h.sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
      VALUES ('child', 'follow-up-turn', 'user-follow-up', 'completed', ${now}, '[]')`;
    const stored = yield* h.read("grandchild");
    yield* h.repo.save(stored, { ...stored, status: "delivered" });
    yield* h.sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, checkpoint_files_json)
      VALUES ('child', 'child-wake-turn', 'delegation-result:grandchild', 'child-final', 'completed', ${now}, '[]')`;
    yield* h.sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('child-final', 'child', 'child-wake-turn', 'assistant', 'Final child answer', 0, ${now}, ${now})`;
    h.setChild(shell("child", "child-wake-turn", "child-runtime"));
    yield* h.repo.observe({
      childThreadId: ThreadId.make("child"),
      runtimeSessionId: RuntimeSessionId.make("child-runtime"),
      observationEpoch: "process-1",
      backgroundPending: false,
      terminal: { turnId: TurnId.make("child-wake-turn"), state: "completed" },
    });
    assert.equal((yield* h.read()).settled?.turnId, "child-turn");
    yield* h.tick(3);
    assert.equal((yield* h.read()).status, "delivered");
    assert.include(h.sent[0]!.message.text, "Delegated task notice (advanced).");
    assert.notInclude(h.sent[0]!.message.text, "Final child answer");
  }).pipe(Effect.provide(layer)),
);

// ── kept invariants ──────────────────────────────────────────────────────

it.effect(
  "keeps initial message ownership immutable on repeated insert and rejects stale writers",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const first = yield* h.read();
      yield* h.repo.insert({ ...first, initialMessageId: MessageId.make("another-run") });
      yield* h.ack();
      assert.isFalse(yield* h.repo.save(first, { ...first, status: "cancelled" }));
      assert.equal((yield* h.read()).initialMessageId, first.initialMessageId);
      const hostile = '\\"\n\u0000'.repeat(9000);
      assert.isBelow(renderCompletionReturn(yield* h.read(), hostile).length, 50000);
    }).pipe(Effect.provide(layer)),
);

it.effect("quarantines one malformed row without starving valid due returns", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.sql`INSERT INTO agent_control_completion_returns (child_thread_id, proposal_id, status, revision, next_check_at, record_json)
    VALUES ('broken', 'broken-proposal', 'waiting', 0, '2000-01-01T00:00:00.000Z', '{bad json')`;
    yield* h.ack();
    yield* h.tick(0);
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
      const h = yield* setup();
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

it.effect("requires completed original dispatch and its exact recorded return authority", () =>
  Effect.gen(function* () {
    const h = yield* setup();
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

it.effect("blocks a child whose project scope changed", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.ack();
    h.setChild({ ...shell("child", "child-turn", "child-runtime"), projectId: "other" as never });
    yield* h.tick(0);
    assert.equal((yield* h.read()).status, "blocked");
    assert.equal(h.sent.length, 0);
  }).pipe(Effect.provide(layer)),
);
