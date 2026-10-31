/**
 * ProviderInstallLock - The lock every Ryco process on this host takes to run a provider
 * installer.
 *
 * Desktop's backend, a CLI service, Nightly and dev servers on one host share one lock folder
 * (independent of RYCO_HOME), so two of them never run `npm i -g` on the same prefix at once,
 * and a provider session does not start while its CLI is being replaced. The lock itself
 * (`../providerInstallLock.ts`) loads with the first install or provider session start.
 *
 * @module ProviderInstallLock
 */
import type { ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ProviderInstallLockRuntime } from "../providerInstallLock.ts";

export interface ProviderInstallLockShape {
  /** The lock, loaded on the first call. */
  readonly lock: Effect.Effect<ProviderInstallLockRuntime>;
  /**
   * Holds a provider process launch while a Ryco process on this host (this one included) runs
   * that instance's installer, so a CLI is not replaced under a starting session. Other
   * installers do not hold it. See `ProviderInstallLockRuntime.beforeLaunch`.
   */
  readonly beforeLaunch: (
    instanceId: ProviderInstanceId,
    provider: ProviderDriverKind,
  ) => Effect.Effect<void>;
}

export class ProviderInstallLock extends Context.Service<
  ProviderInstallLock,
  ProviderInstallLockShape
>()("ryco/provider/Services/ProviderInstallLock") {}
