/**
 * ProviderMaintenanceRunner - Runs one-click provider CLI updates for every connection.
 *
 * Boot carries only this facade: the runner (`providerMaintenanceRunnerRuntime.ts`) loads and is
 * built on the first update, once per process, with the services captured here.
 *
 * @module ProviderMaintenanceRunner
 */
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderUpdateError,
  ServerProviderUpdatedPayload,
} from "@ryco/contracts";
import { Context, Effect, Layer } from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import type { ServerSettingsService } from "../serverSettings.ts";
import type { ProviderInstallLock } from "./Services/ProviderInstallLock.ts";
import type { ProviderRegistry } from "./Services/ProviderRegistry.ts";

export interface ProviderMaintenanceRunnerShape {
  readonly updateProvider: (
    target:
      | ProviderDriverKind
      | {
          readonly provider: ProviderDriverKind;
          readonly instanceId?: ProviderInstanceId | undefined;
        },
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
}

export class ProviderMaintenanceRunner extends Context.Service<
  ProviderMaintenanceRunner,
  ProviderMaintenanceRunnerShape
>()("ryco/provider/ProviderMaintenanceRunner") {}

/** What the runner reads; `ModelManifest` is optional (the bundled manifest otherwise). */
type ProviderMaintenanceRunnerServices =
  | ProviderRegistry
  | ProviderInstallLock
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | ServerSettingsService;

export const layer = Layer.effect(
  ProviderMaintenanceRunner,
  Effect.gen(function* () {
    const context = yield* Effect.context<ProviderMaintenanceRunnerServices>();
    const runner = yield* Effect.cached(
      Effect.promise(() => import("./providerMaintenanceRunnerRuntime.ts")).pipe(
        Effect.flatMap((module) => module.make()),
        Effect.provideContext(context),
      ),
    );
    return ProviderMaintenanceRunner.of({
      updateProvider: (target) => Effect.flatMap(runner, (loaded) => loaded.updateProvider(target)),
    });
  }),
);
