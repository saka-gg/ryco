import type { ServerProvider } from "@ryco/contracts";
import type { Effect, Stream } from "effect";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export interface ServerProviderShape {
  /**
   * Update capabilities for this instance. Resolution may walk PATH and realpath the binary, so it
   * is lazy and memoized; driver construction never waits for it.
   */
  readonly maintenanceCapabilities: Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  /**
   * Refresh only when the managed snapshot's freshness window has elapsed.
   * Concurrent callers join the same in-flight refresh.
   */
  readonly revalidate: Effect.Effect<ServerProvider>;
  /** Whether `revalidate` would return the current snapshot without probing. */
  readonly isFresh?: Effect.Effect<boolean>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /**
   * Identity of every input a probe observes (binary on disk, effective settings, server build).
   * Persisted beside each probed snapshot; absent for sources whose snapshots must never be
   * trusted across restarts.
   */
  readonly probeFingerprint?: Effect.Effect<string>;
  /**
   * Seed the source with a persisted snapshot whose fingerprint still matches, so `revalidate`
   * treats it as fresh instead of running a cold probe. Ignored once the source has probed.
   */
  readonly adoptPersistedSnapshot?: (input: {
    readonly snapshot: ServerProvider;
    readonly checkedAtMs: number;
  }) => Effect.Effect<boolean>;
}
