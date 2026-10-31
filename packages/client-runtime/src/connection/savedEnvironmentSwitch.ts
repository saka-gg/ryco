import type { EnvironmentId } from "@ryco/contracts";

import {
  isSavedEnvironmentSwitchedOff,
  type SavedEnvironmentRecord,
  type SavedEnvironmentRegistryState,
} from "./catalog.ts";

/**
 * Switches a saved machine on or off; `at` is when (ISO time, default now).
 * Only the stored record changes: its credential, caches and pairing stay, and
 * the connection supervisor leaves a switched-off record alone on every sync,
 * resume and launch (`isSavedEnvironmentSwitchedOff`). A Hub-linked route is
 * not a machine and has no switch; pairing the machine again writes a new
 * record, which is on. Its own module, so only the views that offer the
 * switch load it.
 */
export function switchSavedEnvironment(
  registryStore: {
    readonly getState: () => Pick<SavedEnvironmentRegistryState, "byId" | "upsert">;
  },
  environmentId: EnvironmentId,
  enabled: boolean,
  at: string = new Date().toISOString(),
): void {
  const registry = registryStore.getState();
  const current = registry.byId[environmentId];
  if (!current || isSavedEnvironmentSwitchedOff(current) !== enabled) return;
  const { disabledAt: _disabledAt, ...on } = current;
  const next: SavedEnvironmentRecord = enabled ? on : { ...on, disabledAt: at };
  registry.upsert(next);
}
