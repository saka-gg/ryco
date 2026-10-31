import { assert, describe, it } from "@effect/vitest";
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_COMMAND_WATCH_MCP_TOOLS as TOOLS,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type AgentControlCapability,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import { Effect, Option } from "effect";

import {
  CommandWatchFailure,
  type CommandWatchRuntime,
  type CommandWatchStartInput,
} from "../../commandWatch/commandWatchRuntime.ts";
import { isPendingCompletionReturn } from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import { withCommandWatchTools } from "./commandWatchTools.ts";
import type { AgentControlMcpTools } from "./tools.ts";

const now = "2026-10-30T08:00:00.000Z";
const callerId = ThreadId.make("thread-caller");

const session = (
  capabilities: ReadonlyArray<AgentControlCapability> = [AGENT_CONTROL_CAPABILITIES.watchCommands],
): AgentControlSessionRecord => ({
  sessionId: "lease-caller",
  issuedAt: now,
  threadId: callerId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime-caller"),
  grantedCapabilities: capabilities,
  injectionMode: "codex-http",
});

const harness = (
  input: {
    readonly authority?: boolean;
    readonly runtimeMode?: OrchestrationThreadShell["runtimeMode"];
    readonly interactionMode?: OrchestrationThreadShell["interactionMode"];
    readonly delegation?: "pending" | "unreadable" | "none";
  } = {},
) => {
  const started: CommandWatchStartInput[] = [];
  const stopped: Array<{ threadId: string; watchId?: string | undefined }> = [];
  const runtime = {
    start: (request: CommandWatchStartInput) =>
      Effect.sync(() => {
        started.push(request);
        return { watchId: "command-watch:1", started: true, watches: { active: [], ended: [] } };
      }),
    stop: (request: { threadId: ThreadId; watchId?: string | undefined }) =>
      Effect.sync(() => {
        stopped.push(request);
        return { stopped: ["command-watch:1"] };
      }),
    list: () => Effect.succeed({ active: [], ended: [] }),
  } as unknown as CommandWatchRuntime;
  const base: AgentControlMcpTools = {
    descriptors: [],
    descriptorsFor: () => Effect.succeed([]),
    hasTool: () => false,
    isWriteTool: () => false,
    callTool: () => Effect.die("not used"),
  };
  const tools = withCommandWatchTools(base, {
    policy: {
      isEnabled: Effect.succeed(true),
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
                threadId: callerId,
                turnId: TurnId.make("t"),
                boundAt: now,
              }),
        ),
    },
    projections: {
      getThreadShellById: (id) =>
        Effect.succeed(
          Option.some({
            id,
            runtimeMode: input.runtimeMode ?? "full-access",
            interactionMode: input.interactionMode ?? "default",
          } as unknown as OrchestrationThreadShell),
        ),
    },
    watches: { runtime: Effect.succeed(runtime) },
    completionReturns: {
      get: () =>
        input.delegation === "unreadable"
          ? Effect.fail(new Error("ledger unreadable"))
          : Effect.succeed(
              input.delegation === "pending" ? ({ status: "waiting" } as never) : undefined,
            ),
    } as never,
    isPendingCompletionReturn,
  });
  const call = (name: string, args: unknown, as = session()) => tools.callTool(as, name, args);
  return { tools, call, started, stopped };
};

const text = (result: { readonly content: ReadonlyArray<{ readonly text: string }> }) =>
  result.content[0]?.text ?? "";

describe("command watch tools", () => {
  it.effect("start a watch on the caller's own chat, with the default interval", () =>
    Effect.gen(function* () {
      const h = harness();
      const result = yield* h.call(TOOLS.watch, { command: "gh pr checks 12", label: "CI" });
      assert.isUndefined(result.isError);
      assert.deepStrictEqual(h.started, [
        { threadId: callerId, command: "gh pr checks 12", label: "CI", everyMinutes: 10 },
      ]);
      // The target is never chosen by the agent.
      const other = yield* h.call(TOOLS.watch, {
        command: "echo",
        label: "x",
        threadId: "thread-someone-else",
      });
      assert.isTrue(other.isError);
      assert.lengthOf(h.started, 1);
    }),
  );

  it.effect("refuse a caller outside Full access or default mode", () =>
    Effect.gen(function* () {
      for (const mode of [
        { runtimeMode: "approval-required" as const },
        { runtimeMode: "auto-accept-edits" as const },
        { interactionMode: "plan" as const },
      ]) {
        const h = harness(mode);
        const result = yield* h.call(TOOLS.watch, { command: "echo", label: "x" });
        assert.isTrue(result.isError);
        assert.include(text(result), "Full access and default mode");
        assert.lengthOf(h.started, 0);
      }
    }),
  );

  it.effect("refuse an awaited delegated chat, and fail closed when the ledger is unreadable", () =>
    Effect.gen(function* () {
      const pending = harness({ delegation: "pending" });
      const refused = yield* pending.call(TOOLS.watch, { command: "echo", label: "x" });
      assert.include(text(refused), "delegated by another chat");
      const unreadable = harness({ delegation: "unreadable" });
      const failed = yield* unreadable.call(TOOLS.watch, { command: "echo", label: "x" });
      assert.include(text(failed), "Could not check whether this chat was delegated");
      assert.lengthOf(pending.started, 0);
      assert.lengthOf(unreadable.started, 0);
    }),
  );

  it.effect("need exact active-turn authority to change, and the grant to be listed or used", () =>
    Effect.gen(function* () {
      const h = harness({ authority: false });
      assert.include(
        text(yield* h.call(TOOLS.watch, { command: "echo", label: "x" })),
        "active-turn write authority",
      );
      assert.include(text(yield* h.call(TOOLS.unwatch, {})), "active-turn write authority");
      const ungranted = harness();
      assert.isTrue(
        (yield* ungranted.call(TOOLS.list, {}, session([AGENT_CONTROL_CAPABILITIES.read]))).isError,
      );
      assert.deepStrictEqual(
        yield* ungranted.tools.descriptorsFor(session([AGENT_CONTROL_CAPABILITIES.read])),
        [],
      );
      assert.sameMembers(
        (yield* ungranted.tools.descriptorsFor(session())).map((tool) => tool.name),
        Object.values(TOOLS),
      );
      assert.isTrue(ungranted.tools.isWriteTool(TOOLS.watch));
      assert.isFalse(ungranted.tools.isWriteTool(TOOLS.list));
    }),
  );

  it.effect("stop the caller's own watches, and pass the node's refusal on", () =>
    Effect.gen(function* () {
      const h = harness();
      const result = yield* h.call(TOOLS.unwatch, { watchId: "command-watch:1" });
      assert.isUndefined(result.isError);
      assert.deepStrictEqual(h.stopped, [{ threadId: callerId, watchId: "command-watch:1" }]);

      const refusing = withCommandWatchTools(h.tools, {
        policy: { isEnabled: Effect.succeed(true), authorize: () => Effect.void } as never,
        registry: {
          getTurnAuthority: (sessionId: string) =>
            Effect.succeed(
              Option.some({
                sessionId,
                threadId: callerId,
                turnId: TurnId.make("t"),
                boundAt: now,
              }),
            ),
        },
        projections: {
          getThreadShellById: () =>
            Effect.succeed(
              Option.some({
                runtimeMode: "full-access",
                interactionMode: "default",
              } as unknown as OrchestrationThreadShell),
            ),
        },
        watches: {
          runtime: Effect.succeed({
            start: () =>
              Effect.fail(
                new CommandWatchFailure({ detail: "A chat runs at most 5 command watches." }),
              ),
          } as unknown as CommandWatchRuntime),
        },
        completionReturns: undefined,
        isPendingCompletionReturn,
      });
      const sixth = yield* refusing.callTool(session(), TOOLS.watch, {
        command: "echo",
        label: "x",
      });
      assert.isTrue(sixth.isError);
      assert.include(text(sixth), "at most 5 command watches");
    }),
  );
});
