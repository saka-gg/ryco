import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";
import { Deferred, Effect, Layer, Option, Redacted, Stream } from "effect";

import type { AgentControlProviderBridge } from "../../agentControl/ProviderInjection.ts";
import { ServerConfig } from "../../config.ts";
import { makeFakeCopilotClient } from "../testUtils/fakeCopilotClient.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";

const threadId = ThreadId.make("thread-copilot-turn-order");
const instanceId = ProviderInstanceId.make("copilot");
const testLayer = ServerConfig.layerTest("/tmp", { prefix: "ryco-copilot-turn-order-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("keeps each event of an SDK burst on its own turn, and retires the turn that ended", () =>
  Effect.gen(function* () {
    const copilot = makeFakeCopilotClient("copilot-turn-order-session");
    const retired: Array<string | undefined> = [];
    const bridge: AgentControlProviderBridge = {
      issueLease: () =>
        Effect.succeed(
          Option.some({
            sessionId: "copilot-turn-order-control",
            endpointUrl: "http://127.0.0.1:45000/mcp",
            credential: Redacted.make(`rycoac_${"c".repeat(43)}`),
          }),
        ),
      issueStdioBootstrap: () => Effect.succeed(Option.none()),
      revokeLease: () => Effect.void,
      bindTurnAuthority: ({ sessionId, turnId }) =>
        Effect.succeed({ sessionId, threadId, turnId, boundAt: new Date().toISOString() }),
      retireTurnAuthority: (input) => Effect.sync(() => void retired.push(input.turnId)),
    };
    const adapter = yield* makeCopilotAdapter(
      { binaryPath: "copilot" },
      { instanceId, agentControl: bridge, clientFactory: () => copilot.client as never },
    );
    const events: Array<ProviderRuntimeEvent> = [];
    const firstStarted = yield* Deferred.make<void>();
    const bothTurnsCompleted = yield* Deferred.make<void>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
        if (event.type === "turn.started") Deferred.doneUnsafe(firstStarted, Effect.void);
        if (events.filter((entry) => entry.type === "turn.completed").length === 2) {
          Deferred.doneUnsafe(bothTurnsCompleted, Effect.void);
        }
      }),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("copilot"),
      providerInstanceId: instanceId,
      runtimeSessionId: RuntimeSessionId.make("runtime-copilot-turn-order"),
      threadId,
      runtimeMode: "full-access",
    });

    copilot.send("assistant.turn_start", { turnId: "turn-r1" });
    yield* Deferred.await(firstStarted);
    // Mid-turn, one stdout chunk: the SDK calls back for every event before any handler runs.
    copilot.send("assistant.message", { messageId: "message-r1", content: "first round" });
    copilot.send("assistant.turn_end", { turnId: "turn-r1" });
    copilot.send("session.idle", {});
    copilot.send("assistant.turn_start", { turnId: "turn-r2" });
    copilot.send("assistant.message", { messageId: "message-r2", content: "second round" });
    copilot.send("assistant.turn_end", { turnId: "turn-r2" });
    copilot.send("session.idle", {});
    yield* Deferred.await(bothTurnsCompleted);

    const turnOf = (marker: string) =>
      events
        .filter((event) => JSON.stringify(event.raw ?? event.payload).includes(marker))
        .map((event) => String(event.turnId));
    assert.isNotEmpty(turnOf("message-r1"));
    assert.deepStrictEqual(new Set(turnOf("message-r1")), new Set(["turn-r1"]));
    assert.deepStrictEqual(new Set(turnOf("message-r2")), new Set(["turn-r2"]));
    assert.deepStrictEqual(
      events
        .filter((event) => event.type === "turn.completed")
        .map((event) => String(event.turnId)),
      ["turn-r1", "turn-r2"],
    );
    // Each round's end retires that round's authority, never the next one's.
    assert.deepStrictEqual(retired, ["turn-r1", "turn-r1", "turn-r2", "turn-r2"]);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.provide(testLayer)),
);
