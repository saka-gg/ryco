import { assert, describe, it } from "@effect/vitest";
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_EXTERNAL_MCP_TOOL_NAMES,
  AGENT_CONTROL_MCP_TOOL_NAMES,
  AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type AgentControlCapability,
  type OrchestrationCommand,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";

import { findThreadInArray } from "../../orchestration/threadIndex.ts";
import {
  answerSecretRequest,
  scheduleSecretRequestExpiries,
  secretRequestIdFor,
} from "../../secretRequests/secretRequests.ts";
import { threadWakeSource, waitUntil } from "../eventDrivenWait.ts";
import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import { SECRET_REQUEST_TOOL_DESCRIPTOR, withSecretRequestTools } from "./secretRequestTools.ts";
import type { AgentControlMcpTools } from "./tools.ts";

const threadId = ThreadId.make("thread-caller");
const otherThreadId = ThreadId.make("thread-other");
const name = AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL;
const DAY_MS = 24 * 60 * 60 * 1000;

const session = (
  capabilities: ReadonlyArray<AgentControlCapability> = [AGENT_CONTROL_CAPABILITIES.requestSecrets],
  callerThreadId = threadId,
): AgentControlSessionRecord => ({
  sessionId: `lease-${callerThreadId}`,
  issuedAt: "2026-10-31T08:00:00.000Z",
  threadId: callerThreadId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime-caller"),
  grantedCapabilities: capabilities,
  injectionMode: "codex-http",
});

/** A fake engine holding one thread's activities, and a checkout that is not a Git repository. */
const harness = (input: { readonly authority?: boolean; readonly enabled?: boolean } = {}) => {
  const activities: OrchestrationThreadActivity[] = [];
  const dispatched: OrchestrationCommand[] = [];
  const engine = {
    getReadModel: () =>
      Effect.sync(
        () =>
          ({
            threads: [
              { id: threadId, deletedAt: null, activities: [...activities] },
              { id: otherThreadId, deletedAt: null, activities: [] },
            ],
          }) as never,
      ),
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        if (command.type === "thread.activity.append" && command.threadId === threadId) {
          if (!activities.some((activity) => activity.id === command.activity.id)) {
            activities.push(command.activity);
          }
        }
        return { sequence: dispatched.length };
      }),
    subscribeDomainEvents: Effect.die("not used"),
  };
  const checkouts: string[] = [];
  const projections = {
    getThreadCheckpointContext: (id: ThreadId) =>
      Effect.sync(() => {
        checkouts.push(id);
        return Option.none();
      }),
  };
  const base: AgentControlMcpTools = {
    descriptors: [],
    descriptorsFor: () => Effect.succeed([]),
    hasTool: () => false,
    isWriteTool: () => false,
    callTool: () => Effect.die("not used"),
  };
  const tools = withSecretRequestTools(base, {
    policy: {
      isEnabled: Effect.succeed(input.enabled !== false),
      authorize: (request: {
        readonly grantedCapabilities: ReadonlyArray<AgentControlCapability>;
        readonly requiredCapability: AgentControlCapability;
      }) =>
        request.grantedCapabilities.includes(request.requiredCapability)
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
                threadId,
                turnId: TurnId.make("turn-caller"),
                boundAt: "2026-10-31T08:00:00.000Z",
              }),
        ),
    },
    engine: engine as never,
    projections: projections as never,
    helpers: { findThreadInArray, waitUntil, threadWakeSource },
  });
  const deps = { engine: engine as never, projections: projections as never, findThreadInArray };
  return { tools, dispatched, activities, checkouts, deps };
};

const args = {
  requestId: "stripe",
  key: "STRIPE_KEY",
  purpose: "Charge test cards",
  waitMs: 0,
};
const text = (result: { readonly content: ReadonlyArray<{ readonly text: string }> }) =>
  result.content.map((part) => part.text).join("\n");

describe("ryco_request_secret authorization", () => {
  it.effect("is listed and callable only with the secrets.request grant", () =>
    Effect.gen(function* () {
      const h = harness();
      const listed = yield* h.tools.descriptorsFor(session());
      assert.deepEqual(
        listed.map((tool) => tool.name),
        [name],
      );
      assert.isTrue(h.tools.isWriteTool(name));
      const without = session([AGENT_CONTROL_CAPABILITIES.read]);
      assert.deepEqual(yield* h.tools.descriptorsFor(without), []);
      const denied = yield* h.tools.callTool(without, name, args);
      assert.isTrue(denied.isError);
      assert.strictEqual(text(denied), "Capability denied.");
      assert.deepEqual(h.dispatched, []);
      assert.deepEqual(h.checkouts, []);
    }),
  );

  it.effect("needs the caller's exact active turn", () =>
    Effect.gen(function* () {
      const h = harness({ authority: false });
      const refused = yield* h.tools.callTool(session(), name, args);
      assert.isTrue(refused.isError);
      assert.strictEqual(text(refused), "Exact active-turn write authority is unavailable.");
      // A lease bound to another thread's turn does not count either.
      const other = yield* harness().tools.callTool(session(undefined, otherThreadId), name, args);
      assert.isTrue(other.isError);
      assert.deepEqual(h.dispatched, []);
    }),
  );

  it.effect("is hidden while Agent Control is off", () =>
    Effect.gen(function* () {
      const h = harness({ enabled: false });
      assert.deepEqual(yield* h.tools.descriptorsFor(session()), []);
    }),
  );

  it.effect("refuses bad input and a thread without a checkout before opening a card", () =>
    Effect.gen(function* () {
      const h = harness();
      for (const bad of [
        { ...args, key: "lower_case" },
        { ...args, file: "../.env" },
        { ...args, file: "/etc/.env" },
        { ...args, file: ".git/.env" },
        { ...args, value: "no values here" },
      ]) {
        const result = yield* h.tools.callTool(session(), name, bad);
        assert.isTrue(result.isError, JSON.stringify(bad));
      }
      const noCheckout = yield* h.tools.callTool(session(), name, args);
      assert.isTrue(noCheckout.isError);
      assert.include(text(noCheckout), "no checkout");
      // The caller's own thread is the only one ever looked up.
      assert.deepEqual(h.checkouts, [threadId]);
      assert.deepEqual(h.dispatched, []);
    }),
  );

  it("is a private-session tool, never one of the external endpoint's", () => {
    assert.strictEqual(SECRET_REQUEST_TOOL_DESCRIPTOR.name, name);
    assert.notInclude(AGENT_CONTROL_EXTERNAL_MCP_TOOL_NAMES as ReadonlyArray<string>, name);
    assert.notInclude(AGENT_CONTROL_MCP_TOOL_NAMES as ReadonlyArray<string>, name);
  });
});

describe("secret request expiry", () => {
  const openCard = (h: ReturnType<typeof harness>) =>
    Effect.sync(() => {
      const requestId = secretRequestIdFor(threadId, "stripe");
      h.activities.push({
        id: `${requestId}:requested` as never,
        tone: "info",
        kind: "secret.requested",
        summary: "Asked for STRIPE_KEY for .env",
        payload: {
          requestId,
          key: "STRIPE_KEY",
          purpose: "Charge test cards",
          file: ".env",
          expiresAt: new Date(DAY_MS).toISOString(),
        },
        turnId: TurnId.make("turn-caller"),
        createdAt: new Date(0).toISOString(),
      });
      return requestId;
    });

  it.effect("refuses an answer after a day and records the expiry once", () =>
    Effect.gen(function* () {
      const h = harness();
      const requestId = yield* openCard(h);
      yield* TestClock.adjust(DAY_MS);
      const expired = yield* Effect.flip(
        answerSecretRequest(h.deps, { threadId, requestId, answer: { type: "decline" } }),
      );
      assert.strictEqual(expired.reason, "expired");
      const resolutions = h.activities.filter((activity) => activity.kind === "secret.resolved");
      assert.deepEqual(
        resolutions.map((activity) => activity.payload),
        [{ requestId, status: "expired" }],
      );
      const again = yield* Effect.flip(
        answerSecretRequest(h.deps, { threadId, requestId, answer: { type: "decline" } }),
      );
      assert.strictEqual(again.reason, "already-answered");
    }),
  );

  it.effect("tells a polling agent the request expired", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* openCard(h);
      yield* TestClock.adjust(DAY_MS);
      const result = yield* h.tools.callTool(session(), name, args);
      assert.strictEqual((result.structuredContent as { status: string }).status, "expired");
      assert.isTrue(h.activities.some((activity) => activity.kind === "secret.resolved"));
    }),
  );

  it.effect("expires a pending request on its own when its day is up, after a restart too", () =>
    Effect.gen(function* () {
      const h = harness();
      const requestId = yield* openCard(h);
      yield* scheduleSecretRequestExpiries(h.deps, [
        { id: threadId, deletedAt: null, activities: [...h.activities] },
      ]);
      yield* TestClock.adjust(DAY_MS - 1);
      assert.isFalse(h.activities.some((activity) => activity.kind === "secret.resolved"));
      yield* TestClock.adjust(1);
      yield* Effect.yieldNow;
      assert.deepEqual(
        h.activities
          .filter((activity) => activity.kind === "secret.resolved")
          .map((activity) => activity.payload),
        [{ requestId, status: "expired" }],
      );
    }),
  );
});
