import { assert, describe, it } from "@effect/vitest";
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_LINK_PULL_REQUEST_TOOL,
  ProviderInstanceId,
  RuntimeSessionId,
  PullRequestWatchError,
  ThreadId,
  TurnId,
  type AgentControlCapability,
} from "@ryco/contracts";
import { Effect, Option } from "effect";

import type {
  PullRequestLinkInput,
  PullRequestLinkResult,
} from "../../sourceControl/PullRequestWatchService.ts";
import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import { mcpToolCallResult } from "./jsonRpc.ts";
import { withPullRequestLinkTools } from "./pullRequestLinkTools.ts";
import type { AgentControlMcpTools } from "./tools.ts";

const now = "2026-10-30T08:00:00.000Z";

const session = (
  capabilities: ReadonlyArray<AgentControlCapability> = [
    AGENT_CONTROL_CAPABILITIES.read,
    AGENT_CONTROL_CAPABILITIES.watchPullRequests,
  ],
): AgentControlSessionRecord => ({
  sessionId: "lease-thread-caller",
  issuedAt: now,
  threadId: ThreadId.make("thread-caller"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime-caller"),
  grantedCapabilities: capabilities,
  injectionMode: "codex-http",
});

const harness = (input: { readonly authority?: boolean; readonly refuse?: string } = {}) => {
  const calls: PullRequestLinkInput[] = [];
  const base: AgentControlMcpTools = {
    descriptors: [],
    descriptorsFor: () => Effect.succeed([]),
    hasTool: () => false,
    isWriteTool: () => false,
    callTool: () => Effect.die("not used"),
  };
  const tools = withPullRequestLinkTools(base, {
    policy: {
      isEnabled: Effect.succeed(true),
      authorize: (request: {
        readonly grantedCapabilities: ReadonlyArray<AgentControlCapability>;
        readonly requiredCapability: AgentControlCapability;
      }) =>
        request.grantedCapabilities.includes(request.requiredCapability)
          ? Effect.void
          : Effect.fail(new Error("denied")),
    } as never,
    registry: {
      getTurnAuthority: (sessionId: string) =>
        Effect.succeed(
          input.authority === false
            ? Option.none()
            : Option.some({
                sessionId,
                threadId: ThreadId.make("thread-caller"),
                turnId: TurnId.make("turn-caller"),
                boundAt: now,
              }),
        ),
    },
    pullRequestWatch: {
      linkPullRequest: (request) =>
        Effect.suspend(() => {
          calls.push(request);
          if (input.refuse !== undefined) {
            return Effect.fail(
              new PullRequestWatchError({ reason: "no-pull-request", detail: input.refuse }),
            );
          }
          return Effect.succeed({
            number: request.number ?? 12,
            url: "https://github.com/acme/app/pull/12",
            title: "Ship it",
            state: "open",
            alreadyLinked: false,
          } satisfies PullRequestLinkResult);
        }),
    },
  });
  return { tools, calls };
};

const text = (result: { readonly content: ReadonlyArray<{ readonly text?: string }> }) =>
  result.content[0]?.text ?? "";

describe("ryco_link_pull_request", () => {
  it.effect("links to the calling chat's own workspace only", () =>
    Effect.gen(function* () {
      const { tools, calls } = harness();
      assert.isTrue(tools.isWriteTool(AGENT_CONTROL_LINK_PULL_REQUEST_TOOL));
      const result = yield* tools.callTool(session(), AGENT_CONTROL_LINK_PULL_REQUEST_TOOL, {
        number: 12,
      });
      assert.isUndefined(result.isError);
      assert.deepStrictEqual(calls, [{ threadId: ThreadId.make("thread-caller"), number: 12 }]);
      assert.include(text(result), '"alreadyLinked":false');
    }),
  );

  it.effect("refuses another chat's thread id, missing authority and a missing grant", () =>
    Effect.gen(function* () {
      const { tools, calls } = harness();
      const extra = yield* tools.callTool(session(), AGENT_CONTROL_LINK_PULL_REQUEST_TOOL, {
        number: 12,
        threadId: "thread-other",
      });
      assert.isTrue(extra.isError);
      const denied = yield* tools.callTool(
        session([AGENT_CONTROL_CAPABILITIES.read]),
        AGENT_CONTROL_LINK_PULL_REQUEST_TOOL,
        { number: 12 },
      );
      assert.strictEqual(text(denied), "Capability denied.");
      const noTurn = yield* harness({ authority: false }).tools.callTool(
        session(),
        AGENT_CONTROL_LINK_PULL_REQUEST_TOOL,
        { number: 12 },
      );
      assert.strictEqual(text(noTurn), "Exact active-turn write authority is unavailable.");
      assert.deepStrictEqual(calls, []);
    }),
  );

  it.effect("answers with the node's reason when it cannot link", () =>
    Effect.gen(function* () {
      const { tools } = harness({ refuse: "The user removed #12 from this chat's workspace." });
      const result = yield* tools.callTool(session(), AGENT_CONTROL_LINK_PULL_REQUEST_TOOL, {
        url: "https://github.com/acme/app/pull/12",
      });
      assert.isTrue(result.isError);
      assert.strictEqual(text(result), "The user removed #12 from this chat's workspace.");
    }),
  );

  it.effect("is listed only for sessions with the pull request grant", () =>
    Effect.gen(function* () {
      const { tools } = harness();
      const listed = yield* tools.descriptorsFor(session());
      assert.deepStrictEqual(
        listed.map((tool) => tool.name),
        [AGENT_CONTROL_LINK_PULL_REQUEST_TOOL],
      );
      assert.deepStrictEqual(
        yield* tools.descriptorsFor(session([AGENT_CONTROL_CAPABILITIES.read])),
        [],
      );
    }),
  );
});

describe("mcpToolCallResult", () => {
  it("wraps a tool value that is not an object, as MCP requires of structuredContent", () => {
    const results = [{ threadId: "t", snippet: "s" }];
    assert.deepStrictEqual(
      mcpToolCallResult({ content: [{ type: "text", text: "[]" }], structuredContent: results }),
      { content: [{ type: "text", text: "[]" }], structuredContent: { result: results } },
    );
    const object = { content: [], structuredContent: { ok: true } };
    assert.strictEqual(mcpToolCallResult(object), object);
    const error = { content: [{ type: "text", text: "no" }], isError: true };
    assert.strictEqual(mcpToolCallResult(error), error);
  });
});
