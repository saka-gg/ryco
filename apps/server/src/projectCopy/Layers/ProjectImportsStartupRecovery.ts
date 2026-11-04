import { Cause, Effect, Layer } from "effect";

import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { ProjectImports } from "../Services/ProjectImports.ts";

/**
 * Once the server admits commands (startup recovery done, the projection current), deletes what
 * interrupted imports left behind and replays their post-register steps. Building `ProjectImports`
 * already marked them interrupted. Provided in the runtime services beside
 * `ServerRuntimeStartupLive`, above the project copy services.
 */
export const ProjectImportsStartupRecoveryLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const imports = yield* ProjectImports;
    const startup = yield* ServerRuntimeStartup;
    yield* startup.awaitCommandReady.pipe(
      Effect.andThen(imports.recoverOnStartup()),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("project import recovery did not start", {
              cause: Cause.pretty(cause),
            }),
      ),
      Effect.forkScoped,
    );
  }),
);
