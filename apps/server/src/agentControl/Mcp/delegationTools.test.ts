import { assert, it } from "@effect/vitest";
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_DELEGATION_MCP_TOOLS,
  AGENT_CONTROL_EXTERNAL_MCP_TOOL_NAMES,
  AGENT_CONTROL_MCP_TOOLS,
  AGENT_CONTROL_TASK_RESULT_MAX_CHARS,
  AgentControlProposal,
  MessageId,
  OrchestrationThreadShell,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type AgentControlCapability,
  type OrchestrationCommand,
} from "@ryco/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  CompletionReturnRepository,
  CompletionReturnRepositoryLive,
  cancelOwnedCompletionReturn,
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
import { ServerWakeFenceLive } from "../../orchestration/Layers/ServerWakeFence.ts";
import { renderCompletionNotice } from "../completionReturnMessages.ts";
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

/** `cancelRaces`: a concurrent writer wins that many of the cancel's revision CASes. */
const setupWith = (options: { readonly cancelRaces?: number } = {}) =>
  Effect.gen(function* () {
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
      getThreadMessageById: (input: { readonly threadId: ThreadId; readonly messageId: string }) =>
        sql<{ text: string; createdAt: string; updatedAt: string; streaming: number }>`
          SELECT text, created_at AS "createdAt", updated_at AS "updatedAt", is_streaming AS streaming
          FROM projection_thread_messages
          WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}`.pipe(
          Effect.orDie,
          Effect.map(([row]) =>
            row === undefined
              ? Option.none()
              : Option.some({
                  id: MessageId.make(input.messageId),
                  role: "assistant" as const,
                  text: row.text,
                  turnId: TurnId.make("child-turn"),
                  streaming: row.streaming !== 0,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                }),
          ),
        ),
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
    const engineCommands: OrchestrationCommand[] = [];
    /** The child as the engine's model holds it: its queue and whether a user message was sent. */
    const engineChild = {
      entries: [] as Array<{ messageId: string; author: "user" | "agent" }>,
      sent: true,
      /** Runs just before a removal applies (the drain racing the cancel). */
      beforeRemoval: null as (() => void) | null,
    };
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          engineCommands.push(command);
          if (command.type === "thread.queue.remove") {
            engineChild.beforeRemoval?.();
            engineChild.entries = engineChild.entries.filter(
              (entry) => !command.messageIds.includes(entry.messageId as never),
            );
          }
          return { sequence: engineCommands.length };
        }),
      getReadModel: () =>
        Effect.sync(
          () =>
            ({
              threads: [
                {
                  id: "child",
                  messages: engineChild.sent ? [{ id: "child-initial", role: "user" }] : [],
                  followUpQueue:
                    engineChild.entries.length === 0 ? undefined : { entries: engineChild.entries },
                },
              ],
            }) as never,
        ),
    };
    let reads = 0;
    const racingCancel = cancelOwnedCompletionReturn({
      get: (childThreadId: ThreadId) =>
        repo.get(childThreadId).pipe(
          Effect.tap((current) => {
            reads += 1;
            return current && reads <= (options.cancelRaces ?? 0)
              ? repo.save(current, { ...current, detail: `Concurrent write ${reads}.` })
              : Effect.void;
          }),
        ),
      save: repo.save,
    });
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
      control: makeDelegatedTaskControl({
        repository: { ...repo, cancelOwned: racingCancel },
        proposals,
        events,
        projections,
        sql,
        engine,
      }),
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
      projections,
      tools,
      call,
      read,
      ack,
      toReady,
      baseCalls,
      engineCommands,
      engineChild,
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
const setup = setupWith();

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

it.effect("pages a long result read by id, redacted whole so no page shows part of a secret", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.ack();
    // The token straddles the first page boundary of the raw text.
    const raw = `${"a".repeat(AGENT_CONTROL_TASK_RESULT_MAX_CHARS - 20)} ${TOKEN} ${"b".repeat(15_000)}`;
    yield* h.sql`UPDATE projection_thread_messages SET text = ${raw} WHERE message_id = 'answer'`;
    type Page = {
      readonly text: string;
      readonly truncated: boolean;
      readonly version?: string;
      readonly offsetChars?: number;
      readonly totalChars?: number;
      readonly nextOffsetChars?: number | null;
    };
    const readPage = (args: unknown) =>
      h
        .call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, args)
        .pipe(
          Effect.map(
            (result) => (structured(result).tasks[0] as unknown as { result: Page }).result,
          ),
        );

    const first = yield* readPage({ taskId: "child" });
    assert.isTrue(first.truncated);
    assert.equal(first.offsetChars, 0);
    let text = first.text;
    let next = first.nextOffsetChars ?? null;
    while (next !== null) {
      const page = yield* readPage({
        taskId: "child",
        result: { version: first.version, offsetChars: next },
      });
      assert.equal(page.offsetChars, next);
      text += page.text;
      next = page.nextOffsetChars ?? null;
    }
    assert.equal(text.length, first.totalChars);
    assert.include(text, "[REDACTED]");
    assert.notInclude(text, "rycoac_");
    assert.isTrue(text.endsWith("b".repeat(100)));

    // A list shows the start only, without a continuation.
    const [listed] = structured(yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, {}))
      .tasks as unknown as ReadonlyArray<{ result: Page }>;
    assert.isTrue(listed!.result.truncated);
    assert.isUndefined(listed!.result.version);

    // A changed result or a continuation without a task id is refused.
    yield* h.sql`UPDATE projection_thread_messages SET text = ${`${raw}!`} WHERE message_id = 'answer'`;
    for (const args of [
      { taskId: "child", result: { version: first.version, offsetChars: 10 } },
      { result: { version: first.version, offsetChars: 10 } },
    ]) {
      const refused = yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, args);
      assert.isTrue(refused.isError);
      assert.include(refused.content[0]?.text ?? "", "That result page is unavailable");
    }
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
      Effect.provide(ServerWakeFenceLive),
      Effect.provideService(ProviderService, {
        getSession: () => Effect.succeed(Option.none()),
      } as never),
      // A real idle parent: without the acknowledgement this scan would send a wake.
      Effect.provideService(ProjectionSnapshotQuery, h.projections as never),
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

it.effect("acknowledges a notice only when read by id and keeps its outcome readable", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    const record = yield* h.read();
    const text = renderCompletionNotice(record, "request-failed");
    yield* h.repo.save(record, {
      ...record,
      status: "ready",
      capture: { kind: "notice", outcome: "request-failed", capturedAt: now, section: text },
    });
    type Entry = {
      readonly acknowledged: boolean;
      readonly notice: unknown;
      readonly result: unknown;
      readonly return: { readonly status: string; readonly detail: string };
    };
    const read = (args: unknown) =>
      h
        .call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, args)
        .pipe(Effect.map((result) => (structured(result).tasks as unknown as Entry[])[0]!));
    // A list may not reach the model in full, so it never acknowledges.
    const listed = yield* read({});
    assert.isFalse(listed.acknowledged);
    assert.deepStrictEqual(listed.notice, { outcome: "request-failed", text });
    assert.equal((yield* h.read()).status, "ready");
    const task = yield* read({ taskId: "child" });
    assert.isTrue(task.acknowledged);
    assert.deepStrictEqual(task.notice, { outcome: "request-failed", text });
    assert.isNull(task.result);
    assert.equal(task.return.status, "delivered");
    assert.include(task.return.detail, "Notice (request-failed) read by the originating chat");
    const again = yield* read({ taskId: "child" });
    assert.isFalse(again.acknowledged);
    assert.deepStrictEqual(again.notice, { outcome: "request-failed", text });
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

it.effect("never interrupts a task whose return lost the cancel race twice", () =>
  Effect.gen(function* () {
    const h = yield* setupWith({ cancelRaces: 2 });
    h.setChild(runningChild());
    const result = yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel, {
      requestId: "cancel-1",
      taskId: "child",
    });
    assert.isTrue(result.isError);
    assert.equal(result.content[0]?.text, "Task is changing; retry ryco_task_cancel.");
    assert.equal((yield* h.read()).status, "waiting");
    assert.deepStrictEqual(h.baseCalls, []);
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

/** A capped request's task still waiting for a free slot: its first message is queued, held. */
const waitingChild = () =>
  childShell({
    latestTurn: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingUserInput: false,
    followUpQueueSummary: {
      count: 1,
      hold: {
        reason: "paused",
        detail: "Waiting for a free slot: this request runs at most 2 tasks at once.",
        causeKeys: ["delegation-slot:delegation-proposal"],
        heldAt: now,
      },
      headStatus: "queued",
      headPreview: "Fixture task",
    },
  });

type RunEntry = { readonly run: { readonly state: string; readonly detail?: string } };

it.effect("reports a task waiting for a free slot as waiting, with why", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    // Its first message was never sent: no turn exists for it.
    yield* h.sql`DELETE FROM projection_turns WHERE thread_id = 'child'`;
    h.setChild(waitingChild());
    const [task] = structured(
      yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, { taskId: "child" }),
    ).tasks as unknown as ReadonlyArray<RunEntry>;
    assert.equal(task?.run.state, "waiting");
    assert.include(task?.run.detail ?? "", "free slot");
    // Released and about to be sent: starting, as before.
    h.setChild({
      ...waitingChild(),
      followUpQueueSummary: { ...waitingChild().followUpQueueSummary!, hold: null },
    });
    const [released] = structured(
      yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, { taskId: "child" }),
    ).tasks as unknown as ReadonlyArray<RunEntry>;
    assert.equal(released?.run.state, "starting");
    assert.notProperty(released?.run, "detail");
  }).pipe(Effect.provide(layer)),
);

it.effect("reports a waiting task whose chat stopped waiting for it as never started", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.sql`DELETE FROM projection_turns WHERE thread_id = 'child'`;
    h.setChild(waitingChild());
    // The person stopped the delegating chat while the task waited for its slot.
    const record = (yield* h.repo.get(ThreadId.make("child")))!;
    yield* h.repo.save(record, {
      ...record,
      status: "cancelled",
      detail:
        "You stopped the delegating chat before this task's turn came: it stays paused and starts only if you resume it, and its result does not return automatically.",
    });
    const [task] = structured(
      yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, { taskId: "child" }),
    ).tasks as unknown as ReadonlyArray<RunEntry>;
    assert.equal(task?.run.state, "interrupted");
    assert.notProperty(task?.run, "detail");
  }).pipe(Effect.provide(layer)),
);

/** The engine's model of a waiting task: first message, an agent follow-up and a person's entry. */
const waitingInEngine = (h: { readonly engineChild: { entries: unknown; sent: boolean } }) => {
  h.engineChild.sent = false;
  h.engineChild.entries = [
    { messageId: "child-initial", author: "agent" },
    { messageId: "agent-follow-up", author: "agent" },
    { messageId: "person-entry", author: "user" },
  ];
};

it.effect("cancelling a task that waits for a slot takes its first message out of its queue", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.sql`DELETE FROM projection_turns WHERE thread_id = 'child'`;
    h.setChild(waitingChild());
    waitingInEngine(h);
    const cancel = () =>
      h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel, {
        requestId: "cancel-1",
        taskId: "child",
      });
    const result = yield* cancel();
    assert.isUndefined(result.isError);
    assert.equal((yield* h.read()).status, "cancelled");
    assert.deepStrictEqual(h.engineCommands, [
      {
        type: "thread.queue.remove",
        commandId: "delegation-slot-cancel:delegation-proposal:child",
        threadId: "child",
        // The first message and the agent's own follow-up; the person's entry stays.
        messageIds: ["child-initial", "agent-follow-up"],
        createdAt: (h.engineCommands[0] as { readonly createdAt: string }).createdAt,
      },
    ] as unknown as OrchestrationCommand[]);
    assert.deepStrictEqual((result.structuredContent as { interrupt: unknown }).interrupt, {
      requested: false,
      reason: "not started; it will not start",
    });
    assert.deepStrictEqual(h.baseCalls, []);
    assert.deepStrictEqual(
      h.engineChild.entries.map((entry) => entry.messageId),
      ["person-entry"],
    );
    // A retry finds nothing left to remove.
    yield* cancel();
    assert.lengthOf(h.engineCommands, 1);
    // Out of the queue, it reads as stopped before it started, never as starting.
    const { followUpQueueSummary: _emptied, ...emptied } = waitingChild();
    h.setChild(emptied);
    const [task] = structured(
      yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus, { taskId: "child" }),
    ).tasks as unknown as ReadonlyArray<RunEntry>;
    assert.equal(task?.run.state, "interrupted");
  }).pipe(Effect.provide(layer)),
);

it.effect("a cancel that loses the race with the drain answers like one of a starting task", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.sql`DELETE FROM projection_turns WHERE thread_id = 'child'`;
    h.setChild(waitingChild());
    waitingInEngine(h);
    // The drain sends the released first message between the cancel's read and its removal.
    h.engineChild.beforeRemoval = () => {
      h.engineChild.entries = h.engineChild.entries.filter(
        (entry) => entry.messageId !== "child-initial",
      );
      h.engineChild.sent = true;
      h.setChild(runningChild());
    };
    const result = yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel, {
      requestId: "cancel-1",
      taskId: "child",
    });
    assert.equal((yield* h.read()).status, "cancelled");
    assert.lengthOf(h.engineCommands, 1);
    // Not "it will not start": it started, so its running turn is interrupted as before.
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

it.effect("a cancel removes nothing from a task that already sent its first message", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    // Started long ago; the parent queued another message to it since.
    h.setChild({ ...childShell(), followUpQueueSummary: waitingChild().followUpQueueSummary! });
    h.engineChild.entries = [{ messageId: "agent-follow-up", author: "agent" }];
    yield* h.call(AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel, {
      requestId: "cancel-1",
      taskId: "child",
    });
    assert.equal((yield* h.read()).status, "cancelled");
    assert.deepStrictEqual(h.engineCommands, []);
  }).pipe(Effect.provide(layer)),
);
