import { assert, describe, it } from "@effect/vitest";
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_WORKTREE_MCP_TOOLS as TOOLS,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type AgentControlActionPlan,
  type AgentControlCapability,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import { Deferred, Effect, Fiber, Option } from "effect";

import { computeAgentControlPlanDigest } from "../planDigest.ts";
import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import type { AgentControlMcpTools } from "./tools.ts";
import { withWorktreeHandoffTools } from "./worktreeHandoffTools.ts";

const now = "2026-10-31T08:00:00.000Z";
const callerId = ThreadId.make("thread-caller");
const projectId = ProjectId.make("project-1");

const session = (
  capabilities: ReadonlyArray<AgentControlCapability> = [
    AGENT_CONTROL_CAPABILITIES.manageWorkspaces,
  ],
): AgentControlSessionRecord => ({
  sessionId: "lease-caller",
  issuedAt: now,
  threadId: callerId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime-caller"),
  grantedCapabilities: capabilities,
  injectionMode: "codex-http",
});

const shell = (overrides: Partial<OrchestrationThreadShell> = {}) =>
  ({
    id: callerId,
    projectId,
    branch: "main",
    worktreePath: null,
    worktreeId: null,
    archivedAt: null,
    settledAt: null,
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

const receipt = (status: string, result: unknown = null) => ({
  proposalId: "proposal-1",
  requestId: "request-1",
  actionKind: "worktreeHandoff",
  planDigest: "0".repeat(64),
  riskTags: [],
  status,
  createdAt: now,
  updatedAt: now,
  expiresAt: now,
  decidedAt: now,
  result,
});

const harness = (
  input: {
    readonly authority?: boolean;
    readonly enabled?: boolean;
    readonly thread?: Partial<OrchestrationThreadShell>;
    /** Holds every submission until it completes. */
    readonly gate?: Deferred.Deferred<void>;
    /** The outcome is not in within the wait. */
    readonly timedOut?: boolean;
    /** The caller's earlier requests, by request id. */
    readonly earlier?: Record<string, AgentControlActionPlan>;
  } = {},
) => {
  const submitted: AgentControlActionPlan[] = [];
  const waited: string[] = [];
  let thread = shell(input.thread);
  const base: AgentControlMcpTools = {
    descriptors: [],
    descriptorsFor: () => Effect.succeed([]),
    hasTool: () => false,
    isWriteTool: () => false,
    callTool: () => Effect.die("not used"),
  };
  const tools = withWorktreeHandoffTools(base, {
    policy: {
      isEnabled: Effect.succeed(input.enabled ?? true),
      authorize: (request: {
        readonly grantedCapabilities: ReadonlyArray<AgentControlCapability>;
        readonly requiredCapability: AgentControlCapability;
      }) =>
        input.enabled === false
          ? Effect.fail({ _tag: "AgentControlDisabledError" })
          : request.grantedCapabilities.includes(request.requiredCapability)
            ? Effect.void
            : Effect.fail({ _tag: "AgentControlCapabilityDeniedError" }),
    } as never,
    registry: {
      getTurnAuthority: (sessionId: string) =>
        Effect.succeed(
          input.authority === false
            ? Option.none()
            : Option.some({
                sessionId,
                threadId: callerId,
                turnId: TurnId.make("turn-1"),
                boundAt: now,
              }),
        ),
    },
    projections: {
      getThreadShellById: () => Effect.sync(() => Option.some(thread)),
      getProjectShellById: () =>
        Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/repo" } as never)),
    },
    submitMutation: (request) =>
      Effect.gen(function* () {
        submitted.push(request.plan);
        if (input.gate) yield* Deferred.await(input.gate);
        return { receipt: receipt("approved") as never, replayed: false };
      }),
    proposals: {
      findByRequest: (principal, requestId) =>
        Effect.succeed(
          principal.kind !== "provider-session" ||
            principal.threadId !== callerId ||
            input.earlier?.[requestId] === undefined
            ? Option.none()
            : Option.some({
                ...(receipt("completed") as object),
                proposalId: `proposal-${requestId}`,
                requestId,
                principal: { kind: "provider-session", threadId: callerId },
                plan: input.earlier[requestId],
                planDigest: computeAgentControlPlanDigest(input.earlier[requestId]!),
                promptSummary: "Move thread",
                planVersion: 1,
              } as never),
        ),
    },
    waitForTerminal: (_session, proposalId) =>
      Effect.sync(() => {
        waited.push(proposalId);
        if (input.timedOut === true) {
          return { receipt: receipt("executing") as never, timedOut: true };
        }
        // The executor moved the chat.
        thread = shell({ worktreePath: "/worktrees/repo/feature", branch: "feature" });
        return {
          receipt: receipt("completed", {
            outcome: "completed",
            execution: {
              operationId: "operation-1",
              commands: [],
              affectedThreadIds: [callerId],
              worktreeIds: [],
              worktreeHandoff: {
                branch: "feature",
                baseRef: "main",
                startedFromOrigin: false,
                setupScript: "started",
                continuation: "queued",
              },
            },
            detail: "Moved this chat into a new worktree.",
            completedAt: now,
          }) as never,
          timedOut: false,
        };
      }),
    checkoutBranch: () => Effect.succeed({ isRepo: true, refName: "main" }),
  });
  const call = (name: string, args: unknown, as = session()) => tools.callTool(as, name, args);
  return { tools, call, submitted, waited };
};

const text = (result: { readonly content: ReadonlyArray<{ readonly text: string }> }) =>
  result.content[0]!.text;

describe("ryco_worktree_handoff", () => {
  it.effect("moves only the caller's own chat, with the defaults resolved in the plan", () =>
    Effect.gen(function* () {
      const { call, submitted } = harness();
      const result = yield* call(TOOLS.handoff, {
        requestId: "request-1",
        branch: "feature",
        continuationPrompt: "Run the tests",
      });
      assert.isUndefined(result.isError);
      assert.deepStrictEqual(submitted, [
        {
          kind: "worktreeHandoff",
          threadId: callerId,
          branch: "feature",
          startFromOrigin: false,
          runSetupScript: true,
          continuationPrompt: "Run the tests",
        },
      ]);
      assert.deepInclude(result.structuredContent as object, {
        worktreePath: "/worktrees/repo/feature",
        branch: "feature",
        baseRef: "main",
        setupScript: "started",
        continuation: "queued",
        note: "Moved this chat into a new worktree.",
      });
    }),
  );

  it.effect("counts a chat recorded at the project's own checkout as shared", () =>
    Effect.gen(function* () {
      const { call, submitted } = harness({ thread: { worktreePath: "/repo/" } });
      const result = yield* call(TOOLS.handoff, { requestId: "request-1", branch: "feature" });
      assert.isUndefined(result.isError);
      assert.lengthOf(submitted, 1);
    }),
  );

  it.effect("never targets another chat: a threadId argument is refused", () =>
    Effect.gen(function* () {
      const { call, submitted } = harness();
      const result = yield* call(TOOLS.handoff, {
        requestId: "request-1",
        branch: "feature",
        threadId: "thread-other",
      });
      assert.isTrue(result.isError);
      assert.strictEqual(text(result), "Invalid tool arguments.");
      assert.lengthOf(submitted, 0);
    }),
  );

  it.effect("needs exact active-turn authority, the grant and Agent Control on", () =>
    Effect.gen(function* () {
      const args = { requestId: "request-1", branch: "feature" };
      const noTurn = harness({ authority: false });
      assert.strictEqual(
        text(yield* noTurn.call(TOOLS.handoff, args)),
        "Exact active-turn write authority is unavailable.",
      );
      const noGrant = harness();
      assert.strictEqual(
        text(yield* noGrant.call(TOOLS.handoff, args, session([AGENT_CONTROL_CAPABILITIES.read]))),
        "Capability denied.",
      );
      assert.deepStrictEqual(
        yield* noGrant.tools.descriptorsFor(session([AGENT_CONTROL_CAPABILITIES.read])),
        [],
      );
      const off = harness({ enabled: false });
      assert.strictEqual(text(yield* off.call(TOOLS.handoff, args)), "Agent Control is disabled.");
      assert.deepStrictEqual(yield* off.tools.descriptorsFor(session()), []);
      for (const run of [noTurn, noGrant, off]) assert.lengthOf(run.submitted, 0);
      assert.isTrue(noGrant.tools.isWriteTool(TOOLS.handoff));
      assert.isFalse(noGrant.tools.isWriteTool(TOOLS.status));
    }),
  );

  it.effect("refuses a chat that has a worktree, is archived, or a branch Git rejects", () =>
    Effect.gen(function* () {
      const args = { requestId: "request-1", branch: "feature" };
      const inWorktree = harness({ thread: { worktreePath: "/worktrees/repo/other" } });
      assert.match(
        text(yield* inWorktree.call(TOOLS.handoff, args)),
        /already works in its own worktree/,
      );
      const attached = harness({ thread: { worktreeId: "worktree-1" as never } });
      assert.match(text(yield* attached.call(TOOLS.handoff, args)), /own worktree/);
      const archived = harness({ thread: { archivedAt: now } });
      assert.match(text(yield* archived.call(TOOLS.handoff, args)), /archived or settled/);
      const badBranch = harness();
      for (const branch of ["-x", "a..b", "a b", "feature.lock", "HEAD"]) {
        assert.match(
          text(yield* badBranch.call(TOOLS.handoff, { ...args, branch })),
          /Git does not accept/,
        );
      }
      // Names Git would read as another ref, or that read differently from what Git stores.
      for (const branch of [
        "refs/heads/main",
        "heads/main",
        "tags/v1",
        "remotes/origin/main",
        "f".repeat(40),
        "a".repeat(64),
      ]) {
        assert.match(
          text(yield* badBranch.call(TOOLS.handoff, { ...args, branch })),
          /would shadow another Git ref/,
        );
      }
      for (const branch of ["fix-\u202Etxt", "a\u2066b", "\u202Amain"]) {
        const answer = text(yield* badBranch.call(TOOLS.handoff, { ...args, branch }));
        assert.match(answer, /text-direction control characters/);
        // The answer never echoes such a name.
        assert.notInclude(answer, branch);
      }
      for (const run of [inWorktree, attached, archived, badBranch]) {
        assert.lengthOf(run.submitted, 0);
      }
    }),
  );

  it.effect("refuses a second handoff of the same chat while the first runs", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { call, submitted } = harness({ gate });
      const first = yield* Effect.forkChild(
        call(TOOLS.handoff, { requestId: "request-1", branch: "feature" }),
      );
      // Let the first call reach its submission.
      while (submitted.length === 0) yield* Effect.yieldNow;
      const second = yield* call(TOOLS.handoff, { requestId: "request-2", branch: "other" });
      assert.isTrue(second.isError);
      assert.strictEqual(text(second), "A worktree handoff is already in progress for this chat.");
      yield* Deferred.succeed(gate, undefined);
      const firstResult = yield* Fiber.join(first);
      assert.isUndefined(firstResult.isError);
      assert.lengthOf(submitted, 1);
      // Once the first one ended, the chat may try again (the executor then refuses the move).
      const third = yield* call(TOOLS.handoff, { requestId: "request-3", branch: "other" });
      assert.match(text(third), /already works in its own worktree/);
    }),
  );

  it.effect("a replayed request answers with its receipt, even once the chat has moved", () =>
    Effect.gen(function* () {
      const earlier: AgentControlActionPlan = {
        kind: "worktreeHandoff",
        threadId: callerId,
        branch: "feature",
        startFromOrigin: false,
        runSetupScript: true,
      };
      const { call, submitted, waited } = harness({
        // The first call moved the chat.
        thread: { worktreePath: "/worktrees/repo/feature", branch: "feature" },
        earlier: { "request-1": earlier },
      });
      const replayed = yield* call(TOOLS.handoff, { requestId: "request-1", branch: "feature" });
      assert.isUndefined(replayed.isError);
      assert.deepInclude(replayed.structuredContent as object, {
        replayed: true,
        worktreePath: "/worktrees/repo/feature",
        continuation: "queued",
      });
      assert.deepStrictEqual(waited, ["proposal-request-1"]);
      // The same id with another plan is refused; a new id is checked as usual.
      assert.strictEqual(
        text(yield* call(TOOLS.handoff, { requestId: "request-1", branch: "other" })),
        "Request ID was already used with a different plan.",
      );
      assert.match(
        text(yield* call(TOOLS.handoff, { requestId: "request-2", branch: "feature" })),
        /already works in its own worktree/,
      );
      assert.lengthOf(submitted, 0);
    }),
  );

  it.effect("an outcome not in yet tells the agent to end its turn", () =>
    Effect.gen(function* () {
      const { call, submitted } = harness({ timedOut: true });
      const result = yield* call(TOOLS.handoff, { requestId: "request-1", branch: "feature" });
      assert.isUndefined(result.isError);
      assert.lengthOf(submitted, 1);
      const answer = result.structuredContent as { timedOut: boolean; note: string };
      assert.isTrue(answer.timedOut);
      assert.notProperty(answer, "worktreePath");
      assert.include(answer.note, "End your turn now");
      assert.include(answer.note, "ryco_wait_for_control_request");
    }),
  );
});

describe("ryco_worktree_status", () => {
  it.effect("reads the caller's chat and the default base, without turn authority", () =>
    Effect.gen(function* () {
      const shared = harness({ authority: false });
      assert.deepStrictEqual((yield* shared.call(TOOLS.status, {})).structuredContent, {
        inWorktree: false,
        worktreePath: null,
        branch: "main",
        canHandOff: true,
        defaultBaseRef: "main",
      });
      const moved = harness({
        thread: { worktreePath: "/worktrees/repo/feature", branch: "feature" },
      });
      assert.deepInclude((yield* moved.call(TOOLS.status, {})).structuredContent as object, {
        inWorktree: true,
        worktreePath: "/worktrees/repo/feature",
        canHandOff: false,
      });
      assert.strictEqual(
        text(yield* shared.call(TOOLS.status, {}, session([AGENT_CONTROL_CAPABILITIES.read]))),
        "Capability denied.",
      );
    }),
  );
});
