import { useAtomValue } from "@effect/atom-react";
import {
  type SourceControlDiscoveryTarget,
  type SourceControlDiscoveryState,
  createSourceControlDiscoveryManager,
  getSourceControlDiscoveryTargetKey,
  sourceControlDiscoveryStateAtom,
} from "@ryco/client-runtime/sourceControlDiscoveryState";
import { EnvironmentId, type SourceControlDiscoveryResult } from "@ryco/contracts";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";

import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { readEnvironmentConnection } from "../environments/runtime";
import { readLocalApi } from "../localApi";
import { webAppLifecycle } from "../platform/appLifecycle";
import { appAtomRegistry } from "@ryco/client-runtime/rpc";

const SOURCE_CONTROL_DISCOVERY_TARGET = { key: "primary" } as const;
// Installed tools and their auth change rarely, and every discovery probes
// several CLIs (including networked auth checks). Readers revalidate when the
// app returns to the foreground or comes back online instead of on a timer.
const SOURCE_CONTROL_DISCOVERY_STALE_TIME_MS = 5 * 60_000;
const SOURCE_CONTROL_DISCOVERY_IDLE_TTL_MS = 10 * 60_000;

interface SourceControlDiscoveryTargetInput {
  readonly environmentId?: EnvironmentId | null;
}

function sourceControlDiscoveryTarget(
  input?: SourceControlDiscoveryTargetInput,
): SourceControlDiscoveryTarget {
  const environmentId = input?.environmentId ?? null;
  if (!environmentId) {
    return SOURCE_CONTROL_DISCOVERY_TARGET;
  }
  return readPrimaryEnvironmentDescriptor()?.environmentId === environmentId
    ? SOURCE_CONTROL_DISCOVERY_TARGET
    : { key: environmentId };
}

export const sourceControlDiscoveryManager = createSourceControlDiscoveryManager({
  getRegistry: () => appAtomRegistry,
  getClient: (key) => {
    if (key === SOURCE_CONTROL_DISCOVERY_TARGET.key) {
      const primaryEnvironmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
      const primaryConnection = primaryEnvironmentId
        ? readEnvironmentConnection(primaryEnvironmentId)
        : null;
      if (primaryConnection) {
        return primaryConnection.client.server;
      }
      try {
        return readLocalApi()?.server ?? null;
      } catch {
        return null;
      }
    }
    const environmentId = EnvironmentId.make(key);
    const connection = readEnvironmentConnection(environmentId);
    if (connection) {
      return connection.client.server;
    }
    return null;
  },
});

/** Ticks when the app returns to the foreground or the network comes back. */
const sourceControlDiscoveryRevalidateSignal = Atom.readable((get) => {
  let count = 0;
  const unsubscribe = webAppLifecycle.subscribe((event) => {
    if (event === "foreground" || event === "resume" || event === "online") {
      get.setSelf(++count);
    }
  });
  get.addFinalizer(unsubscribe);
  return count;
});

const sourceControlDiscoveryAutoRefreshAtom = Atom.family((targetKey: string) =>
  Atom.make(() =>
    // Background revalidation takes the server's recent result; only an
    // explicit refresh (Settings, command palette) re-probes every CLI.
    Effect.promise(() =>
      sourceControlDiscoveryManager.refresh({ key: targetKey }, undefined, { cached: true }),
    ),
  ).pipe(
    Atom.swr({
      staleTime: SOURCE_CONTROL_DISCOVERY_STALE_TIME_MS,
      revalidateOnMount: true,
      revalidateOnFocus: true,
      focusSignal: sourceControlDiscoveryRevalidateSignal,
    }),
    Atom.setIdleTTL(SOURCE_CONTROL_DISCOVERY_IDLE_TTL_MS),
    Atom.withLabel(`source-control-discovery:auto-refresh:${targetKey}`),
  ),
);

export function refreshSourceControlDiscovery(
  input?: SourceControlDiscoveryTargetInput,
): Promise<SourceControlDiscoveryResult | null> {
  return sourceControlDiscoveryManager.refresh(sourceControlDiscoveryTarget(input));
}

export function getSourceControlDiscoverySnapshot(
  input?: SourceControlDiscoveryTargetInput,
): SourceControlDiscoveryState {
  return sourceControlDiscoveryManager.getSnapshot(sourceControlDiscoveryTarget(input));
}

export function resetSourceControlDiscoveryStateForTests(): void {
  sourceControlDiscoveryManager.reset();
}

const IDLE_SOURCE_CONTROL_DISCOVERY_REFRESH_ATOM = Atom.make(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("source-control-discovery:auto-refresh:idle"),
);

/**
 * Discovery state for a target. While `enabled` (the default) the reader keeps
 * it fresh; a disabled reader only observes what another reader loaded, so a
 * surface can mount before it actually needs auth state.
 */
export function useSourceControlDiscovery(
  input?: SourceControlDiscoveryTargetInput,
  options?: { readonly enabled?: boolean },
): SourceControlDiscoveryState {
  const targetKey =
    getSourceControlDiscoveryTargetKey(sourceControlDiscoveryTarget(input)) ??
    SOURCE_CONTROL_DISCOVERY_TARGET.key;

  useAtomValue(
    (options?.enabled ?? true)
      ? sourceControlDiscoveryAutoRefreshAtom(targetKey)
      : IDLE_SOURCE_CONTROL_DISCOVERY_REFRESH_ATOM,
  );

  return useAtomValue(sourceControlDiscoveryStateAtom(targetKey));
}

/** Whether a discovered provider can serve issue / change request lookups. */
export function hasUsableSourceControlRemote(data: SourceControlDiscoveryResult | null): boolean {
  return (data?.sourceControlProviders ?? []).some(
    (provider) =>
      provider.status === "available" &&
      (provider.auth.status === "authenticated" || provider.auth.status === "unknown"),
  );
}
