/**
 * providerAutoUpdater - installs provider CLI updates unattended while the update window is open.
 *
 * Loaded with unattended updates (`unattendedUpdates.ts`), never on boot. A pass runs
 * {@link FIRST_PASS_DELAY} after unattended updates start and every {@link PASS_INTERVAL} after
 * that, and does nothing unless `automaticUpdates` and provider update checks are on. It walks the
 * instances one at a time and re-checks the window before each pick, so a pass stops as soon as
 * someone is back. A pick spends that instance's try at its newest release (`instanceId@version`)
 * for {@link RETRY_AFTER} on the monotonic clock; the install itself is the one-click runner's
 * (`ProviderMaintenanceRunner.updateProviderUnattended`), which re-checks the window under the
 * install lock. A closed window postpones and frees the try; anything else keeps it.
 *
 * Port of T3 Code's unmerged `ProviderAutoUpdater` (pingdotgg/t3code#17585) and its numbers.
 *
 * @module providerAutoUpdater
 */
import type { ProviderInstanceId, ServerProvider } from "@ryco/contracts";
import { Cause, Clock, Duration, Effect, Option, Schedule } from "effect";

import type { ProviderMaintenanceCapabilities } from "../provider/providerMaintenance.ts";
import type { ProviderMaintenanceRunnerShape } from "../provider/providerMaintenanceRunner.ts";
import type { ProviderRegistryShape } from "../provider/Services/ProviderRegistry.ts";
import type { UpdateWindow } from "./updateWindow.ts";

export const FIRST_PASS_DELAY = Duration.minutes(2);
export const PASS_INTERVAL = Duration.minutes(10);
/** An instance is tried once per release, then again only after this long. */
export const RETRY_AFTER = Duration.hours(6);
const RETRY_AFTER_NANOS = Duration.toNanosUnsafe(RETRY_AFTER);

export interface ProviderAutoUpdaterSources {
  /** `automaticUpdates` and provider update checks are both on; false when unreadable. */
  readonly enabled: Effect.Effect<boolean>;
  readonly window: UpdateWindow;
  readonly providers: Pick<
    ProviderRegistryShape,
    "getProviders" | "getProviderMaintenanceCapabilitiesForInstance"
  >;
  readonly runner: Pick<ProviderMaintenanceRunnerShape, "updateProviderUnattended">;
  /**
   * The snapshot with its version advisory from a latest-release lookup (cached up to an hour).
   * A headless node has no client refreshing advisories, so the updater looks them up itself.
   */
  readonly withVersionAdvisory: (
    snapshot: ServerProvider,
    capabilities: ProviderMaintenanceCapabilities,
  ) => Effect.Effect<ServerProvider>;
}

interface PickedUpdate {
  readonly provider: ServerProvider["driver"];
  readonly targetVersion: string;
  readonly attemptKey: string;
}

export function makeProviderAutoUpdater(sources: ProviderAutoUpdaterSources) {
  // `instanceId@version` to when it was picked, on the monotonic clock.
  const attempts = new Map<string, bigint>();

  /** What to install for one instance, spending its try; undefined when nothing is due. */
  const pick = Effect.fn("ProviderAutoUpdater.pick")(function* (instanceId: ProviderInstanceId) {
    if (!(yield* sources.enabled)) return undefined;
    const current = (yield* sources.providers.getProviders).find(
      (candidate) => candidate.instanceId === instanceId,
    );
    const updateStatus = current?.updateState?.status;
    if (
      current === undefined ||
      !current.enabled ||
      !current.installed ||
      updateStatus === "queued" ||
      updateStatus === "running"
    ) {
      return undefined;
    }
    const capabilities = yield* sources.providers.getProviderMaintenanceCapabilitiesForInstance(
      instanceId,
      current.driver,
    );
    if (capabilities.update === null) return undefined;
    // A failed lookup leaves this instance for the next pass.
    const looked = yield* Effect.option(sources.withVersionAdvisory(current, capabilities));
    const advisory = Option.getOrUndefined(looked)?.versionAdvisory;
    const targetVersion = advisory?.latestVersion;
    if (advisory?.status !== "behind_latest" || !advisory.canUpdate || !targetVersion) {
      return undefined;
    }
    const now = yield* Clock.monotonicTimeNanos;
    for (const [key, pickedAt] of attempts) {
      if (now - pickedAt >= RETRY_AFTER_NANOS) attempts.delete(key);
    }
    const attemptKey = `${instanceId}@${targetVersion}`;
    if (attempts.has(attemptKey)) return undefined;
    attempts.set(attemptKey, now);
    return { provider: current.driver, targetVersion, attemptKey } satisfies PickedUpdate;
  });

  const updateOne = Effect.fn("ProviderAutoUpdater.updateOne")(function* (
    instanceId: ProviderInstanceId,
    picked: PickedUpdate,
  ) {
    const outcome = yield* sources.runner.updateProviderUnattended({
      provider: picked.provider,
      instanceId,
      targetVersion: picked.targetVersion,
      // Under the install lock, which must not close the window on itself.
      beforeInstall: (heldLockKey) =>
        Effect.gen(function* () {
          return (yield* sources.enabled) && (yield* sources.window.isOpen({ heldLockKey }));
        }),
    });
    // Postponed, not failed: the next open window gets a fresh try.
    if (outcome.kind === "postponed") attempts.delete(picked.attemptKey);
    yield* (outcome.kind === "failed" ? Effect.logWarning : Effect.logInfo)(
      "Automatic provider update",
      { instanceId, targetVersion: picked.targetVersion, ...outcome },
    );
  });

  /** One pass over every instance; it never fails, so the schedule keeps running. */
  const pass = Effect.gen(function* () {
    if (!(yield* sources.enabled)) return;
    for (const { instanceId } of yield* sources.providers.getProviders) {
      // Re-checked per instance: the previous install may have taken minutes.
      const picked = yield* sources.window.runIfOpen(pick(instanceId));
      if (Option.isNone(picked)) return;
      if (picked.value !== undefined) yield* updateOne(instanceId, picked.value);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Automatic provider update pass failed", {
            cause: Cause.pretty(cause),
          }),
    ),
    Effect.withSpan("updates.ProviderAutoUpdater.pass"),
  );

  return {
    pass,
    /** The first pass after {@link FIRST_PASS_DELAY}, then one every {@link PASS_INTERVAL}. */
    run: Effect.sleep(FIRST_PASS_DELAY).pipe(
      Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(PASS_INTERVAL)))),
      Effect.asVoid,
    ),
  };
}
