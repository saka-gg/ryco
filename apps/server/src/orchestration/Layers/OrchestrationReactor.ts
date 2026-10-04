import { Effect, Layer } from "effect";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ContextHandoffCoordinator } from "../Services/ContextHandoffCoordinator.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const contextHandoffCoordinator = yield* ContextHandoffCoordinator;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* contextHandoffCoordinator.recover();
    yield* checkpointReactor.recover();
    yield* Effect.all(
      [
        providerRuntimeIngestion.start(),
        providerCommandReactor.start(),
        checkpointReactor.start(),
        threadDeletionReactor.start(),
      ],
      { concurrency: "unbounded", discard: true },
    );
  });

  return {
    start,
    recoverProviderIntents: () => providerCommandReactor.recoverIntents(),
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
