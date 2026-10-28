import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@ryco/contracts";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { AgentProcessPriorityOffLive } from "../agentProcessPriority.ts";
import { GrokDriver } from "./GrokDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "grok-driver-test" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
      ),
    ),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(AgentProcessPriorityOffLive),
  Layer.provideMerge(ServerSettingsService.layerTest()),
);

describe("GrokDriver", () => {
  it.effect("never probes in the background; probes stay demand-driven", () =>
    Effect.gen(function* () {
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok"),
        displayName: undefined,
        environment: [],
        enabled: false,
        config: GrokDriver.defaultConfig(),
      });
      const isFresh = instance.snapshot.isFresh ?? Effect.succeed(false);
      expect(yield* isFresh).toBe(false);

      // A periodic refresh would have probed by now and left a fresh snapshot.
      yield* TestClock.adjust("16 minutes");
      expect(yield* isFresh).toBe(false);

      // Demand still probes.
      yield* instance.snapshot.refresh;
      expect(yield* isFresh).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
