import { useMemo, useSyncExternalStore } from "react";

import { getWsConnectionStatusForEnvironment } from "@ryco/client-runtime/rpc";
import type {
  SavedEnvironmentRecord,
  SavedEnvironmentRuntimeState,
} from "@ryco/client-runtime/connection";

import {
  createEnvironmentActions,
  type EnvironmentActions,
} from "../../connection/environmentActions";
import { useConnectionRegistry } from "../../providers/ConnectionRegistryProvider";
import { useWsConnectionStatus, wsUiStateForEnvironment } from "../../rpc/wsConnectionState";
import { connectionToneForEnvironment } from "./connectionTone";
import { resolveAppPairingTarget } from "./pairingTarget";
import type { StatusTone } from "../../components/StatusPill";

// Registry-hook rewrite (§2 Connections D / §3-24): reads the catalog stores via
// useSyncExternalStore and composes the tested environmentActions. Never surfaces
// a bearer token — rows carry label/url/state only (§3-25 secret boundary).
export interface ConnectionRow {
  readonly record: SavedEnvironmentRecord;
  readonly runtime: SavedEnvironmentRuntimeState;
  readonly tone: StatusTone;
  readonly statusLabel: string;
}

export function useConnectionActions(): EnvironmentActions {
  const registry = useConnectionRegistry();
  return useMemo(
    () => createEnvironmentActions({ registry, resolvePairingTarget: resolveAppPairingTarget }),
    [registry],
  );
}

export function useSavedEnvironments(): {
  readonly rows: ReadonlyArray<ConnectionRow>;
  readonly isLoading: boolean;
} {
  const { catalog } = useConnectionRegistry();
  const registryState = useSyncExternalStore(
    catalog.registryStore.subscribe,
    catalog.registryStore.getState,
    catalog.registryStore.getState,
  );
  const runtimeState = useSyncExternalStore(
    catalog.runtimeStore.subscribe,
    catalog.runtimeStore.getState,
    catalog.runtimeStore.getState,
  );
  // Subscribed as the re-render trigger only: every per-environment status write
  // also writes the global atom, so this hook fires whenever any row's keyed
  // slot changes. Each row's tone must read its OWN environment's status —
  // saved environments multi-connect, and one node reconnecting must not
  // repaint every other node's pill.
  const wsStatus = useWsConnectionStatus();
  void wsStatus;

  const rows = Object.values(registryState.byId).map((record): ConnectionRow => {
    const runtime = catalog.getRuntime(record.environmentId);
    const wsUiState = wsUiStateForEnvironment(
      getWsConnectionStatusForEnvironment(record.environmentId),
    );
    const tone = connectionToneForEnvironment(runtime.connectionState, wsUiState);
    const statusLabel = runtime.authState === "requires-auth" ? "Needs re-pair" : tone.label;
    return { record, runtime, tone, statusLabel };
  });
  // Hermes in the supported development client does not yet expose `toSorted`.
  // `rows` is a fresh array, so mutating it here cannot affect registry state.
  rows.sort((left, right) =>
    left.record.label.localeCompare(right.record.label, undefined, { sensitivity: "base" }),
  );
  // runtimeState referenced so the store subscription re-renders on runtime change.
  void runtimeState;

  return { rows, isLoading: !catalog.hasHydrated() };
}
