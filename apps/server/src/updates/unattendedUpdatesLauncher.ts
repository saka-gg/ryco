/**
 * unattendedUpdatesLauncher - starts unattended updates once a node's owner turns them on.
 *
 * Boot carries only this: it watches `automaticUpdates` and provider update checks and loads
 * `unattendedUpdates.ts` (provider CLI updates, and a CLI service node's own updates) with
 * `import()` the first time both are on (the default is off, so most nodes never load it). It subscribes to settings changes before it reads the settings, so a
 * change made in between still starts it, and a failed load is tried again every
 * {@link LOAD_RETRY_INTERVAL}. Dev servers never start it: they share the host's CLIs with the
 * real install.
 *
 * @module unattendedUpdatesLauncher
 */
import type { ServerSettings } from "@ryco/contracts";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Schedule,
  Stream,
} from "effect";
import { HttpClient } from "effect/http";

import { ServerConfig } from "../config.ts";
import { nodeReleaseChannel, RYCO_CLI_PACKAGE } from "../nodeUpdate/installation.ts";
import { isActiveNodeUpdateRun, NodeUpdateService } from "../nodeUpdate/NodeUpdateService.ts";
import {
  NODE_UPDATE_AUTO_SKIP_FILE_NAME,
  NODE_UPDATE_DIRECTORY_NAME,
} from "../nodeUpdate/updateProtocol.ts";
import { AgentWorkActivity } from "../orchestration/AgentWorkActivity.ts";
import { enrichProviderSnapshotWithVersionAdvisory } from "../provider/providerMaintenance.ts";
import { ProviderMaintenanceRunner } from "../provider/providerMaintenanceRunner.ts";
import { ProviderInstallLock } from "../provider/Services/ProviderInstallLock.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { isTerminalWorking } from "../terminal/terminalActivity.ts";
import { ClientInteraction } from "./ClientInteraction.ts";
import { RestartSensitiveWork } from "./restartSensitiveWork.ts";

/** A failed load of the updater is tried again this long after. */
export const LOAD_RETRY_INTERVAL = Duration.minutes(5);

/** Unattended updates act only with both settings on. */
export const automaticUpdatesEnabled = (
  settings: Pick<ServerSettings, "automaticUpdates" | "enableProviderUpdateChecks">,
): boolean => settings.automaticUpdates && settings.enableProviderUpdateChecks;

/** The launcher over `load`, the updater's `import()` (a stand-in in tests). */
export const makeUnattendedUpdatesLauncher = (
  load: () => Promise<typeof import("./unattendedUpdates.ts")>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      if (config.devUrl !== undefined) return;
      const serverSettings = yield* ServerSettingsService;
      const providers = yield* ProviderRegistry;
      const runner = yield* ProviderMaintenanceRunner;
      const installLock = yield* ProviderInstallLock;
      const clientInteraction = yield* ClientInteraction;
      const httpClient = yield* HttpClient.HttpClient;
      const agentWork = yield* AgentWorkActivity;
      const nodeUpdate = yield* NodeUpdateService;
      const terminals = yield* TerminalManager;
      const restartSensitiveWork = yield* RestartSensitiveWork;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const enabled = serverSettings.getSettings.pipe(
        Effect.map(automaticUpdatesEnabled),
        Effect.orElseSucceed(() => false),
      );

      const turnedOn = yield* Deferred.make<void>();
      const noteTurnedOn = Deferred.succeed(turnedOn, undefined);
      // Started at once, so it is subscribed before the read below.
      const watching = yield* serverSettings.streamChanges.pipe(
        Stream.filter(automaticUpdatesEnabled),
        Stream.take(1),
        Stream.runDrain,
        Effect.andThen(noteTurnedOn),
        Effect.forkScoped({ startImmediately: true }),
      );
      if (yield* enabled) yield* noteTurnedOn;

      const loadUpdater = Effect.tryPromise(load).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Automatic updates could not load; trying again", { cause }),
        ),
        Effect.retry(Schedule.spaced(LOAD_RETRY_INTERVAL)),
      );
      yield* Deferred.await(turnedOn).pipe(
        Effect.andThen(Fiber.interrupt(watching)),
        Effect.andThen(loadUpdater),
        Effect.flatMap((module) =>
          module.runUnattendedUpdates({
            enabled,
            providers,
            runner,
            installLock,
            clientInteraction,
            agentWork,
            busyTerminals: terminals.listDiagnostics.pipe(
              Effect.map((list) => list.some(isTerminalWorking)),
            ),
            restartSensitiveWork,
            node: {
              update: nodeUpdate,
              packageName: RYCO_CLI_PACKAGE,
              autoSkipPath: path.join(
                config.stateDir,
                NODE_UPDATE_DIRECTORY_NAME,
                NODE_UPDATE_AUTO_SKIP_FILE_NAME,
              ),
              releaseChannelOf: nodeReleaseChannel,
              isActiveRun: isActiveNodeUpdateRun,
            },
            httpClient,
            fileSystem,
            path,
            withVersionAdvisory: (snapshot, capabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, capabilities).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.provideService(ServerSettingsService, serverSettings),
              ),
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Automatic updates stopped", {
                cause: Cause.pretty(cause),
              }),
        ),
        Effect.forkScoped,
      );
    }),
  );

export const UnattendedUpdatesLauncherLive = makeUnattendedUpdatesLauncher(
  () => import("./unattendedUpdates.ts"),
);
