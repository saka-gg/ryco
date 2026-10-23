import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  assertTurnIdsOnly,
  drainRuntimeEvents,
  makeRetentionProbe,
  type RetentionProbe,
} from "../testUtils/adapterRetention.ts";
import { makeFakeCopilotClient, type FakeCopilotClient } from "../testUtils/fakeCopilotClient.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";

const ROUNDS = 100;

// Plain function: an Effect.gen frame would keep its last round's tracked events alive.
function sendToolRound(copilot: FakeCopilotClient, probe: RetentionProbe, round: number): void {
  probe.track(
    copilot.send("assistant.message_delta", {
      messageId: "copilot-retention-message",
      deltaContent: probe.payload(2_000),
    }),
  );
  const toolCallId = `copilot-retention-call-${round}`;
  copilot.send("tool.execution_start", {
    toolCallId,
    toolName: "bash",
    arguments: { command: `cat f${round}` },
  });
  probe.track(
    copilot.send("tool.execution_complete", {
      toolCallId,
      success: true,
      result: { content: probe.payload() },
    }),
  );
}

function sendFinalMessage(copilot: FakeCopilotClient, probe: RetentionProbe): void {
  probe.track(
    copilot.send("assistant.message", {
      messageId: "copilot-retention-message",
      content: probe.payload(2_000),
    }),
  );
}

const isToolCompleted = (event: ProviderRuntimeEvent) =>
  event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call";
const isDelta = (event: ProviderRuntimeEvent) => event.type === "content.delta";

describe("Copilot adapter retention", () => {
  const testLayer = ServerConfig.layerTest("/tmp", { prefix: "ryco-copilot-retention-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const instanceId = ProviderInstanceId.make("copilot");

  it.live("retention: keeps no Copilot events of a turn", () =>
    Effect.gen(function* () {
      const copilot = makeFakeCopilotClient("copilot-retention-session");
      const probe = makeRetentionProbe();
      const adapter = yield* makeCopilotAdapter(
        { binaryPath: "copilot" },
        { instanceId, clientFactory: () => copilot.client as never },
      );
      const events = yield* drainRuntimeEvents(adapter.streamEvents);
      const threadId = ThreadId.make("thread-copilot-retention");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("copilot"),
        providerInstanceId: instanceId,
        runtimeSessionId: RuntimeSessionId.make("runtime-copilot-retention"),
        threadId,
        runtimeMode: "full-access",
      });

      copilot.send("assistant.turn_start", { turnId: "turn-1" });
      // Each SDK event is handled in its own fiber, so wait for every tracked event's runtime event
      // (each delta, each tool completion), plus an untracked sentinel delta sent last.
      const toolsCompleted = events.expect(isToolCompleted, ROUNDS);
      const deltasSeen = events.expect(isDelta, ROUNDS + 1);
      for (let round = 0; round < ROUNDS; round += 1) sendToolRound(copilot, probe, round);
      copilot.send("assistant.message_delta", {
        messageId: "copilot-retention-message",
        deltaContent: "sentinel",
      });
      yield* toolsCompleted;
      yield* deltasSeen;
      assert.equal(probe.tracked, 2 * ROUNDS);
      assert.equal(yield* Effect.promise(probe.reachable), 0, "reachable mid-turn");

      const turnCompleted = events.expect((event) => event.type === "turn.completed");
      sendFinalMessage(copilot, probe);
      copilot.send("assistant.turn_end", { turnId: "turn-1" });
      copilot.send("session.idle", {});
      yield* turnCompleted;

      assert.equal(probe.tracked, 2 * ROUNDS + 1);
      assert.equal(yield* Effect.promise(probe.reachable), 0, "reachable after the turn");
      assertTurnIdsOnly(yield* adapter.readThread(threadId), [TurnId.make("turn-1")]);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  );
});
