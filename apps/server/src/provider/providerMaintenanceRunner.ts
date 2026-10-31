/**
 * ProviderMaintenanceRunner - Runs one-click provider CLI updates for every connection.
 *
 * Boot carries only this facade: the runner (`providerMaintenanceRunnerRuntime.ts`) loads and is
 * built on the first update, once per process, with the services captured here. One-click and
 * unattended updates (`updates/providerAutoUpdater.ts`) share it: one gate, one install path.
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

/** An update nobody asked for right now (`automaticUpdates`), for one provider instance. */
export interface UnattendedProviderUpdateInput {
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  /** The release a pass picked; nothing is installed unless a fresh lookup still names it. */
  readonly targetVersion: string;
  /**
   * The last check, under both locks, right before the installer starts: whether the update
   * window is still open and the setting still on. It gets the host install lock this run holds,
   * which must not close the window on itself. False postpones; a failure counts as false.
   */
  readonly beforeInstall: (heldLockKey: string) => Effect.Effect<boolean>;
}

/**
 * What an unattended update did. Only `installed` and `failed` ran an installer and recorded the
 * instance's update state (as a one-click update does); `postponed` and `skipped` left it as it
 * was. `postponed` means "try again in the next open window", `skipped` "not this release".
 */
export type UnattendedProviderUpdateOutcome =
  | { readonly kind: "installed"; readonly version: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "postponed"; readonly reason: string }
  | { readonly kind: "skipped"; readonly reason: string };

export interface ProviderMaintenanceRunnerShape {
  readonly updateProvider: (
    target:
      | ProviderDriverKind
      | {
          readonly provider: ProviderDriverKind;
          readonly instanceId?: ProviderInstanceId | undefined;
        },
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
  /**
   * Installs `targetVersion` unattended, only if it was published at least 48 hours ago, a fresh
   * manifest rates it `supported`, its install can be pinned to it (or is a self-updating install
   * Ryco identified), the instance is still behind it, and `beforeInstall` agrees. Afterwards the
   * installed version must be `targetVersion` and rated `supported`, or the run is recorded as
   * failed. Never waits for a lock: one that is held postpones.
   */
  readonly updateProviderUnattended: (
    input: UnattendedProviderUpdateInput,
  ) => Effect.Effect<UnattendedProviderUpdateOutcome>;
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
      updateProviderUnattended: (input) =>
        Effect.flatMap(runner, (loaded) => loaded.updateProviderUnattended(input)),
    });
  }),
);
