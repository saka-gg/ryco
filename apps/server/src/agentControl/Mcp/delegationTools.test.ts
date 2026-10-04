import { assert, it } from "@effect/vitest";
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_DELEGATION_MCP_TOOLS,
  AGENT_CONTROL_EXTERNAL_MCP_TOOL_NAMES,
  AGENT_CONTROL_MCP_TOOLS,
  AgentControlProposal,
  OrchestrationThreadShell,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type AgentControlCapability,
} from "@ryco/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CompletionReturnRepository,
  CompletionReturnRepositoryLive,
} from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import { AgentControlProposalRepositoryLive } from "../../persistence/Layers/AgentControlProposals.ts";
import {
  AgentControlPrincipalScope,
  AgentControlProposalRepository,
} from "../../persistence/Services/AgentControlProposals.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandApplication } from "../../orchestration/Services/OrchestrationCommandApplication.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import { AgentControlProposalEventsLive } from "../Layers/AgentControlProposalEvents.ts";
import { makeCompletionReturnDelivery } from "../Layers/CompletionReturnDelivery.ts";
import { completionFixture, completionFixtureTime as now } from "../completionReturnTestSupport.ts";
import { makeDelegatedTaskControl } from "../delegatedTaskControl.ts";
import { withDelegationTools } from "./delegationTools.ts";
import type { AgentControlMcpToolResult, AgentControlMcpTools } from "./tools.ts";

const layer = Layer.mergeAll(
  CompletionReturnRepositoryLive,
  AgentControlProposalRepositoryLive,
  OrchestrationCommandReceiptRepositoryLive,
  AgentControlProposalEventsLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const TOKEN = `rycoac_${"a".repeat(43)}`;
const QUESTION = "Which database password should I use?";

const childShell = (overrides: Partial<OrchestrationThreadShell> = {}) => ({
  ...Schema.decodeUnknownSync(OrchestrationThreadShell)({
    id: "child",
    projectId: "project-1",
    title: `Child ${TOKEN}`,
    modelSelection: { instanceId: "codex", model: "fixture" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: "child-turn",
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    },
    createdAt: now,
    updatedAt: now,
    session: {
      threadId: "child",
      status: "ready",
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeSessionId: "child-runtime",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
    latestUserMessageAt: now,
    hasPendingApprovals: false,
    hasPendingUserInput: true,
    hasActionableProposedPlan: false,
  }),
  ...overrides,
});
const runningChild = () =>
  childShell({
    session: {
      ...childShell().session!,
      status: "running",
      activeTurnId: TurnId.make("child-turn"),
    },
  });

const session = (
  capabilities: ReadonlyArray<AgentControlCapability> = [
    AGENT_CONTROL_CAPABILITIES.read,
    AGENT_CONTROL_CAPABILITIES.interruptThread,
  ],
  threadId = "parent",
): AgentControlSessionRecord => ({
  sessionId: `lease-${threadId}`,
  issuedAt: now,
  threadId: ThreadId.make(threadId),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("parent-runtime"),
  grantedCapabilities: capabilities,
  injectionMode: "codex-http",
});

const setup = Effect.gen(function* () {
  const repo = yield* CompletionReturnRepository;
  const sql = yield* SqlClient.SqlClient;
  const proposals = yield* AgentControlProposalRepository;
  const events = yield* AgentControlProposalEvents;
  yield* repo.insert(completionFixture());
  yield* proposals.insert({
    proposal: Schema.decodeUnknownSync(AgentControlProposal)({
      proposalId: "delegation-proposal",
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
    }),
    principalScope: AgentControlPrincipalScope.make("fixture"),
  });
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES ('child', 'project-1', 'Child', '{"instanceId":"codex","model":"fixture"}', 'approval-required', 'default', ${now}, ${now})`;
  yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
    VALUES ('child', 'child-turn', 'child-initial', 'answer', 'completed', ${now}, ${now}, ${now}, '[]')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('answer', 'child', 'child-turn', 'assistant', ${`Done. Token ${TOKEN} found.`}, 0, ${now}, ${now})`;

  let child: OrchestrationThreadShell = childShell();
  let enabled = true;
  let authorityThread: string | null = "parent";
  const baseCalls: Array<{ name: string; args: unknown; returnStatus: string | undefined }> = [];
  const projections = {
    getThreadShellById: (id: ThreadId) =>
      Effect.succeed(
        id === "child"
          ? Option.some(child)
          : id === "parent"
            ? Option.some({ ...childShell(), id, title: "Parent", hasPendingUserInput: false })
            : Option.none(),
      ),
  };
  const base: AgentControlMcpTools = {
    descriptors: [],
    descriptorsFor: () => Effect.succeed([]),
    hasTool: (name) => name === AGENT_CONTROL_MCP_TOOLS.interruptThread,
    isWriteTool: (name) => name === AGENT_CONTROL_MCP_TOOLS.interruptThread,
    callTool: (_session, name, args) =>
      repo.get(ThreadId.make("child")).pipe(
        Effect.orDie,
        Effect.map((record): AgentControlMcpToolResult => {
          baseCalls.push({ name, args, returnStatus: record?.status });
          return {
            content: [{ type: "text", text: "{}" }],
            structuredContent: { proposalId: "interrupt-proposal", status: "executing" },
          };
        }),
      ),
  };
  const policy = {
    isEnabled: Effect.sync(() => enabled),
    authorize: (input: {
      readonly grantedCapabilities: ReadonlyArray<AgentControlCapability>;
      readonly requiredCapability: AgentControlCapability;
    }) =>
      enabled && input.grantedCapabilities.includes(input.requiredCapability)
        ? Effect.void
        : (Effect.fail(new Error("denied")) as never),
  };
  const tools = withDelegationTools(base, {
    policy: policy as never,
    registry: {
      getTurnAuthority: (sessionId: string) =>
        Effect.succeed(
          authorityThread === null || sessionId !== `lease-${authorityThread}`
            ? Option.none()
            : Option.some({
                sessionId,
                threadId: ThreadId.make(authorityThread),
                turnId: TurnId.make("parent-turn-2"),
                boundAt: now,
              }),
        ),
    },
    control: makeDelegatedTaskControl({ repository: repo, proposals, events, projections, sql }),
  });
  const call = (name: string, args: unknown, caller = session()) =>
    tools.callTool(caller, name, args);
  const read = () => repo.get(ThreadId.make("child")).pipe(Effect.map((record) => record!));
  const ack = (state: "completed" | "error" | "interrupted" = "completed") =>
    repo.observe({
      childThreadId: ThreadId.make("child"),
      runtimeSessionId: RuntimeSessionId.make("child-runtime"),
      observationEpoch: "process-1",
      backgroundPending: false,
      terminal: { turnId: TurnId.make("child-turn"), state },
    });
  const toReady = Effect.gen(function* () {
    yield* ack();
    const record = yield* read();
    yield* repo.save(record, {
      ...record,
      status: "ready",
      capture: { kind: "result", outcome: "completed", capturedAt: now, section: "Section" },
    });
  });
  return {
    repo,
    sql,
    tools,
    call,
    read,
    ack,
    toReady,
    baseCalls,
    setChild: (value: OrchestrationThreadShell) => {
      child = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setAuthority: (threadId: string | null) => {
      authorityThread = threadId;
    },
  };
});

const structured = (result: AgentControlMcpToolResult) => {
  assert.isUndefined(result.isError, JSON.stringify(result.content));
  return result.structuredContent as {
    readonly tasks: ReadonlyArray<Record<string, never>>;
    readonly truncated: boolean;
  };
};

it.effect(
  "lists both tools for a private session with grants; the external catalog has neither",
  () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const names = (yield* h.tools.descriptorsFor(session())).map((tool) => tool.name);
      assert.includeMembers(names, [
        AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus,
        AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel,
      ]);
      const readOnly = (yield* h.tools.descriptorsFor(
        session([AGENT_CONTROL_CAPABILITIES.read]),
      )).map((tool) => tool.name);
      assert.deepStrictEqual(readOnly, [AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus]);
      h.setEnabled(false);
      assert.deepStrictEqual(yield* h.tools.descriptorsFor(session()), []);
      assert.isTrue(h.tools.isWriteTool(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel));
      assert.isFalse(h.tools.isWriteTool(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus));
      const external: ReadonlyArray<string> = AGENT_CONTROL_EXTERNAL_MCP_TOOL_NAMES;
      assert.notInclude(external, AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus);
      assert.notInclude(external, AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel);
    }).pipe(Effect.provide(layer)),
);

it.effect("refuses another thread's task", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    h.setAuthority("intruder");
    const intruder = session(undefined, "intruder");
    for (const result of [
      yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, { taskId: "child" }, intruder),
      yield* h.call(
        AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel,
        { requestId: "cancel-1", taskId: "child" },
        intruder,
      ),
    ]) {
      assert.isTrue(result.isError);
      assert.equal(result.content[0]?.text, "Not a returnToOrigin task delegated by this chat.");
    }
    const listed = structured(
      yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, {}, intruder),
    );
    assert.deepStrictEqual(listed.tasks, []);
    assert.equal((yield* h.read()).status, "waiting");
  }).pipe(Effect.provide(layer)),
);

it.effect("returns redacted untrusted results and only a pending-question flag", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.ack();
    yield* h.sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      VALUES ('question', 'child', 'info', 'user-input.requested', ${QUESTION}, ${JSON.stringify({ questions: [{ id: "q1", question: QUESTION }] })}, ${now})`;
    const result = yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, {});
    const [task] = structured(result).tasks as unknown as ReadonlyArray<{
      readonly taskId: string;
      readonly title: string;
      readonly result: { readonly text: string; readonly untrustedChildOutput: true };
      readonly run: { readonly hasPendingUserInput: boolean; readonly state: string };
    }>;
    assert.equal(task?.taskId, "child");
    assert.include(task!.result.text, "[REDACTED]");
    assert.notInclude(JSON.stringify(result), TOKEN);
    assert.isTrue(task!.result.untrustedChildOutput);
    assert.isTrue(task!.run.hasPendingUserInput);
    assert.equal(task!.run.state, "completed");
    assert.notInclude(JSON.stringify(result), QUESTION);
  }).pipe(Effect.provide(layer)),
);

it.effect("reports a child whose initial start failed as failed", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      VALUES ('failure', 'child', 'error', 'provider.turn.start.failed', 'Failed', ${JSON.stringify({ messageId: "child-initial" })}, ${now})`;
    const [task] = structured(
      yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, { taskId: "child" }),
    ).tasks as unknown as ReadonlyArray<{ readonly run: { readonly state: string } }>;
    assert.equal(task?.run.state, "failed");
  }).pipe(Effect.provide(layer)),
);

it.effect("acknowledges a ready task read during the exact turn, so no wake is sent", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.toReady;
    const [task] = structured(
      yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, { taskId: "child" }),
    ).tasks as unknown as ReadonlyArray<{
      readonly acknowledged: boolean;
      readonly return: { readonly status: string };
    }>;
    assert.isTrue(task?.acknowledged);
    assert.equal(task?.return.status, "delivered");
    assert.equal((yield* h.read()).status, "delivered");
    const sent: unknown[] = [];
    const worker = yield* makeCompletionReturnDelivery.pipe(
      Effect.provideService(ProviderService, {
        getSession: () => Effect.succeed(Option.none()),
      } as never),
      Effect.provideService(ProjectionSnapshotQuery, {
        getThreadShellById: () => Effect.succeed(Option.none()),
      } as never),
      Effect.provideService(OrchestrationCommandApplication, {
        apply: (command: unknown) => Effect.sync(() => sent.push(command)),
      } as never),
      Effect.provideService(AgentControlPolicy, { isEnabled: Effect.succeed(true) } as never),
    );
    yield* worker.scan(new Date(Date.parse(now) + 10_000).toISOString());
    assert.deepStrictEqual(sent, []);
    assert.equal((yield* h.read()).status, "delivered");
  }).pipe(Effect.provide(layer)),
);

it.effect("does not acknowledge without exact authority or for a waiting task", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, { taskId: "child" });
    assert.equal((yield* h.read()).status, "waiting");
    yield* h.toReady;
    h.setAuthority(null);
    const [task] = structured(
      yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, { taskId: "child" }),
    ).tasks as unknown as ReadonlyArray<{ readonly acknowledged: boolean }>;
    assert.isFalse(task?.acknowledged);
    assert.equal((yield* h.read()).status, "ready");
  }).pipe(Effect.provide(layer)),
);

it.effect("requires exact authority and an enabled policy to cancel", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    h.setAuthority(null);
    const unauthorized = yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel, {
      requestId: "cancel-1",
      taskId: "child",
    });
    assert.equal(
      unauthorized.content[0]?.text,
      "Exact active-turn write authority is unavailable.",
    );
    h.setAuthority("parent");
    h.setEnabled(false);
    assert.isTrue(
      (yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel, {
        requestId: "cancel-1",
        taskId: "child",
      })).isError,
    );
    const withoutCapability = yield* h.call(
      AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel,
      { requestId: "cancel-1", taskId: "child" },
      session([AGENT_CONTROL_CAPABILITIES.read]),
    );
    assert.isTrue(withoutCapability.isError);
    assert.equal((yield* h.read()).status, "waiting");
  }).pipe(Effect.provide(layer)),
);

it.effect("cancels the return before forwarding an interrupt for the child's active turn", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    h.setChild(runningChild());
    const result = yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel, {
      requestId: "cancel-1",
      taskId: "child",
    });
    assert.isUndefined(result.isError);
    assert.equal((yield* h.read()).status, "cancelled");
    assert.deepStrictEqual(h.baseCalls, [
      {
        name: AGENT_CONTROL_MCP_TOOLS.interruptThread,
        args: { requestId: "cancel-1", threadId: "child", turnId: "child-turn" },
        returnStatus: "cancelled",
      },
    ]);
    assert.deepStrictEqual((result.structuredContent as { interrupt: unknown }).interrupt, {
      proposalId: "interrupt-proposal",
      status: "executing",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("does not cancel a return that is already being delivered", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    const record = yield* h.read();
    yield* h.repo.save(record, { ...record, status: "dispatching" });
    h.setChild(runningChild());
    const result = yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel, {
      requestId: "cancel-1",
      taskId: "child",
    });
    assert.equal((yield* h.read()).status, "dispatching");
    assert.deepStrictEqual((result.structuredContent as { interrupt: unknown }).interrupt, {
      requested: false,
      reason: "already being delivered",
    });
    assert.deepStrictEqual(h.baseCalls, []);
  }).pipe(Effect.provide(layer)),
);

it.effect("cancels an idle task without an interrupt", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    const result = yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel, {
      requestId: "cancel-1",
      taskId: "child",
    });
    assert.equal((yield* h.read()).status, "cancelled");
    assert.deepStrictEqual((result.structuredContent as { interrupt: unknown }).interrupt, {
      requested: false,
      reason: "not running",
    });
    assert.deepStrictEqual(h.baseCalls, []);
  }).pipe(Effect.provide(layer)),
);
