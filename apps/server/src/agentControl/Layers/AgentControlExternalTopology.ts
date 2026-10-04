import { Effect, Layer } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import {
  evaluateExternalMcpTopology,
  HUB_CONNECTED_EXTERNAL_TOPOLOGY,
} from "../externalTopology.ts";
import {
  AgentControlExternalTopologyService,
  type AgentControlExternalTopologyShape,
} from "../Services/AgentControlExternalTopology.ts";

const makeAgentControlExternalTopology = Effect.gen(function* () {
  const config = yield* ServerConfig;
  let topology = evaluateExternalMcpTopology(config);
  const closers: Array<Effect.Effect<void>> = [];
  const handOff = yield* Semaphore.make(1);

  const yieldToHub: AgentControlExternalTopologyShape["yieldToHub"] = handOff.withPermits(1)(
    Effect.gen(function* () {
      // Narrow first: a listener that starts after this reads the new topology
      // and stays down, and one already starting is closed below once its own
      // transition finishes.
      if (topology.available) topology = HUB_CONNECTED_EXTERNAL_TOPOLOGY;
      for (const close of closers) yield* close;
    }),
  );

  return {
    current: () => topology,
    yieldToHub,
    onYieldToHub: (close) =>
      Effect.sync(() => {
        closers.push(close);
      }),
  } satisfies AgentControlExternalTopologyShape;
});

export const AgentControlExternalTopologyLive = Layer.effect(
  AgentControlExternalTopologyService,
  makeAgentControlExternalTopology,
);
