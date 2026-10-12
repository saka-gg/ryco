import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  ServerProvider as ServerProviderSchema,
} from "@ryco/contracts";
import { Cause, Effect, FileSystem, Path, Schema } from "effect";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import type { ConfiguredProviderIdentity } from "./Services/ProviderInstanceRegistry.ts";

/**
 * Freshness record persisted next to a probed snapshot. `fingerprint` names every probe input
 * (binary identity, effective settings, server build); a restart that computes the same
 * fingerprint may trust the snapshot until `checkedAt` plus the persisted-freshness window
 * instead of re-running a cold probe.
 */
export const ProviderProbeFreshness = Schema.Struct({
  fingerprint: Schema.String,
  checkedAt: Schema.String,
});
export type ProviderProbeFreshness = typeof ProviderProbeFreshness.Type;

// The snapshot fields stay at the top level so pre-freshness cache files decode unchanged.
const ProviderStatusCacheFile = Schema.Struct({
  ...ServerProviderSchema.fields,
  probeFreshness: Schema.optionalKey(ProviderProbeFreshness),
});

const decodeProviderStatusCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProviderStatusCacheFile),
);

export interface ProviderStatusCacheEntry {
  readonly provider: ServerProvider;
  readonly probeFreshness: ProviderProbeFreshness | undefined;
}

export const orderProviderSnapshots = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> =>
  [...providers].toSorted(
    (left, right) =>
      (left.displayName ?? "").localeCompare(right.displayName ?? "") ||
      left.driver.localeCompare(right.driver) ||
      left.instanceId.localeCompare(right.instanceId),
  );

/**
 * Seed a configured instance from its persisted snapshot before its driver exists. Identity
 * must match and the enabled state must agree with settings (a toggle is only reflected once
 * the driver reports it); presentation fields always follow current settings.
 */
export const hydrateCachedProviderFromConfig = (input: {
  readonly cachedProvider: ServerProvider;
  readonly identity: ConfiguredProviderIdentity;
}): ServerProvider | undefined => {
  const { cachedProvider, identity } = input;
  if (
    cachedProvider.instanceId !== identity.instanceId ||
    cachedProvider.driver !== identity.driverKind ||
    cachedProvider.enabled !== identity.enabled
  ) {
    return undefined;
  }
  const {
    updateState: _updateState,
    accentColor: _cachedAccentColor,
    ...cachedWithoutVolatile
  } = cachedProvider;
  return {
    ...cachedWithoutVolatile,
    ...(identity.displayName ? { displayName: identity.displayName } : {}),
    ...(identity.accentColor ? { accentColor: identity.accentColor } : {}),
  };
};

/**
 * Resolve the on-disk cache path for a provider instance snapshot.
 *
 * File naming: `<cacheDir>/<instanceId>.json`. For the default instance of
 * a built-in kind this equals the legacy `<kind>.json` path (because
 * `defaultInstanceIdForDriver(kind).toString() === kind`), so existing
 * cached snapshots remain readable without any rename step.
 *
 * Non-default instances (e.g. `codex_personal`) land in their own files and
 * never collide with other instances.
 *
 * Cache contents must still carry matching `instanceId` + `driver` identity
 * before hydration. The filename alone is not trusted as a routing key.
 */
export const resolveProviderStatusCachePath = Effect.fn("resolveProviderStatusCachePath")(
  function* (input: {
    readonly cacheDir: string;
    readonly instanceId: ProviderInstanceId;
  }): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    return path.join(input.cacheDir, `${input.instanceId}.json`);
  },
);

/**
 * Legacy kind-keyed path resolver retained for callers that still think in
 * terms of `ProviderDriverKind`. Prefer `resolveProviderStatusCachePath` with an
 * `instanceId`; new code should route through the instance registry.
 *
 * @deprecated use `resolveProviderStatusCachePath` with an instance id.
 */
export const resolveLegacyProviderStatusCachePath = Effect.fn(
  "resolveLegacyProviderStatusCachePath",
)(function* (input: {
  readonly cacheDir: string;
  readonly provider: ProviderDriverKind;
}): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  return path.join(input.cacheDir, `${input.provider}.json`);
});

export const readProviderStatusCacheEntry = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return undefined;
    }

    const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    return yield* decodeProviderStatusCache(trimmed).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.logWarning("failed to parse provider status cache, ignoring", {
            path: filePath,
            issues: Cause.pretty(cause),
          }).pipe(Effect.as(undefined)),
        onSuccess: ({ probeFreshness, ...provider }): Effect.Effect<ProviderStatusCacheEntry> =>
          Effect.succeed({ provider, probeFreshness }),
      }),
    );
  });

export const readProviderStatusCache = (filePath: string) =>
  readProviderStatusCacheEntry(filePath).pipe(Effect.map((entry) => entry?.provider));

export const writeProviderStatusCache = (input: {
  readonly filePath: string;
  readonly provider: ServerProvider;
  readonly probeFreshness?: ProviderProbeFreshness | undefined;
}) => {
  const { updateState: _updateState, ...cacheableProvider } = input.provider;
  return writeFileStringAtomically({
    filePath: input.filePath,
    contents: `${JSON.stringify(
      input.probeFreshness
        ? { ...cacheableProvider, probeFreshness: input.probeFreshness }
        : cacheableProvider,
      null,
      2,
    )}\n`,
  });
};
