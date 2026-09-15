import { ProjectMemoryError } from "@ryco/contracts";
import { Effect, Option } from "effect";
import { ProjectMemoryService } from "./ProjectMemoryService.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

/** Runs after the existing orphan-runtime reconciliation, before command readiness. */
export const recoverProjectMemorySubmissions = Effect.gen(function* () {
  const memory = yield* Effect.serviceOption(ProjectMemoryService);
  if (Option.isNone(memory)) return;
  const providers = yield* ProviderService;
  yield* memory.value.recoverSubmissions((runtime) =>
    Effect.gen(function* () {
      const result = yield* providers.stopSessionBinding(runtime);
      if (result === "timed-out")
        return yield* Effect.fail(
          new ProjectMemoryError({
            reason: "unavailable",
            message:
              "Prior memory submission runtime is still active. Stop the runtime and restart the node to recover.",
          }),
        );
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError(
        () =>
          new ProjectMemoryError({
            reason: "unavailable",
            message:
              "Could not confirm prior memory submission runtime stopped. Stop the runtime and restart the node to recover.",
          }),
      ),
    ),
  );
});
