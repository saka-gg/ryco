import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
} from "@ryco/contracts";
import type { CopilotClientOptions } from "@github/copilot-sdk";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { drainRuntimeEvents } from "../testUtils/adapterRetention.ts";
import { makeFakeCopilotClient } from "../testUtils/fakeCopilotClient.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";

describe("Copilot adapter thread marker", () => {
  const testLayer = ServerConfig.layerTest("/tmp", { prefix: "ryco-copilot-marker-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const instanceId = ProviderInstanceId.make("copilot");

  it.live("starts each session's CLI with its thread, so the jobs it runs carry it", () =>
    Effect.gen(function* () {
      const copilot = makeFakeCopilotClient("copilot-marker-session");
      const options: Array<CopilotClientOptions> = [];
      const adapter = yield* makeCopilotAdapter(
        { binaryPath: "copilot" },
        {
          instanceId,
          clientFactory: (clientOptions) => {
            options.push(clientOptions);
            return copilot.client as never;
          },
        },
      );
      yield* drainRuntimeEvents(adapter.streamEvents);
      const threadId = ThreadId.make("thread-copilot-marker");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("copilot"),
        providerInstanceId: instanceId,
        runtimeSessionId: RuntimeSessionId.make("runtime-copilot-marker"),
        threadId,
        runtimeMode: "full-access",
      });
      assert.equal(options[0]?.env?.RYCO_THREAD_ID, threadId);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  );
});
