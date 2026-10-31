/**
 * ProviderInstallLockLive - The host-wide provider install lock, loaded on first need.
 *
 * Boot carries only this facade: the lock (`../providerInstallLock.ts`), with the folder it
 * resolves, loads with the first install or provider session start.
 *
 * @module ProviderInstallLockLive
 */
import { Effect, Layer } from "effect";

import type { ProviderInstallLockRuntime } from "../providerInstallLock.ts";
import { ProviderInstallLock } from "../Services/ProviderInstallLock.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";

/** The lock on `directory`: the host's shared folder when omitted, a temp folder in tests. */
export const makeProviderInstallLockLive = (directory?: string) =>
  Layer.effect(
    ProviderInstallLock,
    Effect.gen(function* () {
      // Names each instance's installer, so a launch waits for that installer's lock only.
      const providers = yield* ProviderRegistry;
      let loading: Promise<ProviderInstallLockRuntime> | undefined;
      const lock = Effect.promise(() => {
        if (loading === undefined) {
          const started = import("../providerInstallLock.ts").then((module) =>
            module.makeProviderInstallLock({ directory }),
          );
          // A failed load (say, server files replaced on disk under a running node) is tried
          // again by the next caller instead of failing every one after it.
          started.catch(() => {
            if (loading === started) loading = undefined;
          });
          loading = started;
        }
        return loading;
      });
      return {
        lock,
        beforeLaunch: (instanceId, provider) =>
          Effect.flatMap(lock, (loaded) =>
            loaded.beforeLaunch(
              providers.getProviderMaintenanceCapabilitiesForInstance(instanceId, provider),
            ),
          ).pipe(
            // A launch goes ahead without the lock rather than fail: before the lock existed it
            // never waited. An install still fails closed through `lock`.
            Effect.catchDefect((cause) =>
              Effect.logWarning("provider launch went ahead without the install lock", { cause }),
            ),
          ),
      };
    }),
  );

export const ProviderInstallLockLive = makeProviderInstallLockLive();
