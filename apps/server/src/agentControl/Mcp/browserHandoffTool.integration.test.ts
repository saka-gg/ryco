import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AGENT_CONTROL_CAPABILITIES,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import type { BrowserHandoffBridgeRequest } from "@ryco/contracts/browser-handoff";
import { Effect, Fiber, Layer, Option } from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { NO_DELEGATION_LIMITS } from "../../orchestration/delegationLimits.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import { findThreadInArray } from "../../orchestration/threadIndex.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import {
  answerUserActionRequest,
  userActionRequestIdFor,
} from "../../userActionRequests/userActionRequests.ts";
import { threadWakeSource, waitUntil } from "../eventDrivenWait.ts";
import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import { withComputerUseTools } from "./computerTools.ts";
import type { AgentControlMcpTools } from "./tools.ts";

const layer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(
      Layer.succeed(ProjectAvatarStore, {
        write: () => Effect.die("unused"),
        read: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
    ),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-browser-handoff-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const noTools: AgentControlMcpTools = {
  descriptors: [],
  descriptorsFor: () => Effect.succeed([]),
  hasTool: () => false,
  isWriteTool: () => false,
  callTool: () => Effect.die("not used"),
};

/** The desktop's /handoff bridge, as a small state machine the test steers. */
function fakeDesktop() {
  const state = {
    requests: [] as BrowserHandoffBridgeRequest[],
    active: new Set<string>(),
    met: false,
    alreadyMet: false,
    ended: new Map<string, string>(),
  };
  const handle = async (url: string | URL | Request, init?: RequestInit) => {
    assert.strictEqual(String(url), "http://127.0.0.1:12345/handoff");
    const request = JSON.parse(String(init?.body)) as BrowserHandoffBridgeRequest;
    state.requests.push(request);
    const answer = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (request.op === "begin") {
      if (state.alreadyMet) {
        return answer({
          status: "already-met",
          page: { href: "https://jira.test/dashboard", title: "Dashboard", ready: "complete" },
        });
      }
      state.active.add(request.requestId);
      return answer({ status: "handed-off" });
    }
    if (request.op === "probe") {
      return answer(
        state.active.has(request.requestId)
          ? { status: "active", met: state.met }
          : { status: "missing" },
      );
    }
    state.active.delete(request.requestId);
    const outcome = state.ended.get(request.requestId) ?? request.outcome;
    state.ended.set(request.requestId, outcome);
    return answer({
      status: "ended",
      outcome,
      tab: "tab-1",
      url: "https://jira.test/dashboard",
      page: { href: "https://jira.test/dashboard", title: "Dashboard", ready: "complete" },
      withheld: { requests: 4, messages: 0 },
      scrubbed: 1,
      stillPaused: false,
      waitedMs: 12_000,
    });
  };
  // A fetch for the bridge only: the tool posts JSON and reads the body.
  const fetcher: typeof fetch = Object.assign(handle, { preconnect: () => undefined });
  return { state, fetcher };
}

const setup = (key: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const threadId = ThreadId.make(`thread-${key}`);
    const projectId = ProjectId.make(`project-${key}`);
    const createdAt = new Date().toISOString();
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${key}`),
      projectId,
      title: "Hand-off",
      workspaceRoot: process.cwd(),
      defaultModelSelection: null,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${key}`),
      threadId,
      projectId,
      title: "Hand-off",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    const desktop = fakeDesktop();
    const handoff = { engine, findThreadInArray, waitUntil, threadWakeSource };
    const tools = withComputerUseTools(noTools, {
      config: { url: "http://127.0.0.1:12345/control", token: "a".repeat(43) },
      policy: {
        isEnabled: Effect.succeed(true),
        delegationLimits: Effect.succeed(NO_DELEGATION_LIMITS),
        requireEnabled: () => Effect.void,
        requiredCapabilityForAction: () => AGENT_CONTROL_CAPABILITIES.read,
        authorize: () => Effect.void,
      },
      registry: {
        getTurnAuthority: (sessionId) =>
          Effect.succeed(
            Option.some({ sessionId, threadId, turnId: TurnId.make("turn-1"), boundAt: createdAt }),
          ),
      },
      fetch: desktop.fetcher,
      handoff,
    });
    const caller: AgentControlSessionRecord = {
      sessionId: `lease-${key}`,
      issuedAt: createdAt,
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeSessionId: RuntimeSessionId.make("runtime-1"),
      grantedCapabilities: [AGENT_CONTROL_CAPABILITIES.controlBrowser],
      injectionMode: "codex-http",
    };
    const call = (args: Record<string, unknown>) =>
      tools.callTool(caller, "ryco_browser", {
        action: "handoff",
        browser: "ryco",
        tab: "tab-1",
        requestId: "jira",
        ...args,
      });
    return { threadId, desktop, call, deps: handoff };
  });

const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  result.content.map((item) => item.text ?? "").join("\n");

const hasPendingUserInput = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    return Option.getOrThrow(yield* projections.getThreadShellById(threadId)).hasPendingUserInput;
  });

layer("ryco_browser handoff", (it) => {
  it.effect(
    "hands the tab over, answers pending, and ends on the user's Done with the page now",
    () =>
      Effect.gen(function* () {
        const { threadId, desktop, call, deps } = yield* setup("done");
        const first = yield* call({
          message: "Sign in to Jira with your company account.",
          done_when: { url: "/dashboard" },
          waitMs: 0,
        });
        assert.isUndefined(first.isError);
        assert.match(textOf(first), /The user has tab-1 now/);
        assert.deepInclude(first.structuredContent as object, { status: "pending", tab: "tab-1" });
        assert.deepInclude(desktop.state.requests[0] as object, {
          op: "begin",
          tab: "tab-1",
          need: "sign-in",
          doneWhen: { url: "/dashboard" },
        });
        assert.isTrue(yield* hasPendingUserInput(threadId));

        // The next call waits; the user's Done on the card wakes it.
        const waiting = yield* Effect.forkChild(call({ waitMs: 20_000 }));
        yield* answerUserActionRequest(deps, {
          threadId,
          requestId: userActionRequestIdFor(threadId, "jira"),
          answer: "done",
        });
        const ended = yield* Fiber.join(waiting);
        const words = textOf(ended);
        // The structured result carries the same sentences: some clients show only it.
        assert.strictEqual((ended.structuredContent as { message: string }).message, words);
        assert.match(words, /The user said they are done/);
        assert.match(words, /Page now: https:\/\/jira\.test\/dashboard — "Dashboard"/);
        assert.match(words, /a password or code field still on the page was emptied/);
        assert.isFalse(yield* hasPendingUserInput(threadId));
        // The surface hook gave the tab back with the user's outcome.
        assert.isTrue(
          desktop.state.requests.some(
            (request) => request.op === "end" && request.outcome === "done",
          ),
        );
      }),
  );

  it.effect("ends by itself once done_when holds on the desktop", () =>
    Effect.gen(function* () {
      const { desktop, call } = yield* setup("condition");
      yield* call({ message: "Sign in.", done_when: { url: "/dashboard" }, waitMs: 0 });
      desktop.state.met = true;
      const ended = yield* call({ waitMs: 20_000 });
      assert.match(textOf(ended), /done_when matched/);
      assert.deepInclude(ended.structuredContent as object, { status: "condition-met" });
    }),
  );

  it.effect("hands nothing over when done_when already holds", () =>
    Effect.gen(function* () {
      const { threadId, desktop, call } = yield* setup("already");
      desktop.state.alreadyMet = true;
      const result = yield* call({ message: "Sign in.", done_when: { url: "/dashboard" } });
      assert.match(textOf(result), /already holds in tab-1, so nothing was handed to the user/);
      assert.isFalse(yield* hasPendingUserInput(threadId));
    }),
  );

  it.effect("refuses a selector that reads field values and a first call without a message", () =>
    Effect.gen(function* () {
      const { desktop, call } = yield* setup("refusals");
      const bad = yield* call({ message: "Sign in.", done_when: { selector: "input[value=x]" } });
      assert.isTrue(bad.isError);
      assert.match(textOf(bad), /cannot test field values/);
      const bare = yield* call({});
      assert.isTrue(bare.isError);
      assert.match(textOf(bare), /needs a message/);
      assert.lengthOf(desktop.state.requests, 0);
    }),
  );

  it.effect("lets the agent withdraw its hand-off", () =>
    Effect.gen(function* () {
      const { threadId, call } = yield* setup("cancel");
      yield* call({ message: "Sign in.", waitMs: 0 });
      const cancelled = yield* call({ cancel: true });
      assert.match(textOf(cancelled), /was withdrawn/);
      assert.isFalse(yield* hasPendingUserInput(threadId));
    }),
  );
});
