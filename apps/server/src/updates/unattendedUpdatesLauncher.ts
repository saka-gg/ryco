/**
 * unattendedUpdatesLauncher - starts unattended updates once a node's owner turns them on.
 *
 * Boot carries only this: it watches `automaticUpdates` and provider update checks and loads
 * `unattendedUpdates.ts` with `import()` the first time both are on (the default is off, so most
 * nodes never load it). Dev servers never start it: they share the host's CLIs with the real
 * install.
 *
 * @module unattendedUpdatesLauncher
 */
import type { ServerSettings } from "@ryco/contracts";
import { Cause, Effect, Layer, Stream } from "effect";
import { HttpClient } from "effect/http";

import { ServerConfig } from "../config.ts";
import { makeAgentWorkActivity } from "../orchestration/AgentWorkActivity.ts";
import type { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import { enrichProviderSnapshotWithVersionAdvisory } from "../provider/providerMaintenance.ts";
import { ProviderMaintenanceRunner } from "../provider/providerMaintenanceRunner.ts";
import { ProviderInstallLock } from "../provider/Services/ProviderInstallLock.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ClientInteraction } from "./ClientInteraction.ts";

/** Unattended updates act only with both settings on. */
export const automaticUpdatesEnabled = (
  settings: Pick<ServerSettings, "automaticUpdates" | "enableProviderUpdateChecks">,
): boolean => settings.automaticUpdates && settings.enableProviderUpdateChecks;

export const UnattendedUpdatesLauncherLive = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* ServerConfig).devUrl !== undefined) return;
    const serverSettings = yield* ServerSettingsService;
    const providers = yield* ProviderRegistry;
    const runner = yield* ProviderMaintenanceRunner;
    const installLock = yield* ProviderInstallLock;
    const clientInteraction = yield* ClientInteraction;
    const httpClient = yield* HttpClient.HttpClient;
    const agentWorkServices = yield* Effect.context<
      OrchestrationEngineService | ThreadBackgroundLivenessService
    >();
    const enabled = serverSettings.getSettings.pipe(
      Effect.map(automaticUpdatesEnabled),
      Effect.orElseSucceed(() => false),
    );

    yield* Stream.fromEffect(
      serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null)),
    ).pipe(
      Stream.concat(serverSettings.streamChanges),
      Stream.filter((settings) => settings !== null && automaticUpdatesEnabled(settings)),
      Stream.take(1),
      Stream.runDrain,
      Effect.andThen(Effect.promise(() => import("./unattendedUpdates.ts"))),
      Effect.flatMap((module) =>
        module.runUnattendedUpdates({
          enabled,
          providers,
          runner,
          installLock,
          clientInteraction,
          withVersionAdvisory: (snapshot, capabilities) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, capabilities).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provideService(ServerSettingsService, serverSettings),
            ),
          makeAgentWork: makeAgentWorkActivity.pipe(Effect.provideContext(agentWorkServices)),
        }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Automatic provider updates stopped", {
              cause: Cause.pretty(cause),
            }),
      ),
      Effect.forkScoped,
    );
  }),
);
