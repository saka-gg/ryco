/**
 * Unified settings hook.
 *
 * Abstracts the split between server-authoritative settings (persisted in
 * `settings.json` on the server, fetched via `server.getConfig`) and
 * client-only settings (persisted in localStorage).
 *
 * Consumers use `useSettings(selector)` to read, and `useUpdateSettings()` to
 * write. The hook transparently routes reads/writes to the correct backing
 * store.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  UnifiedSettings,
} from "@ryco/contracts/settings";
import { ensureLocalApi } from "~/localApi";
import { splitUnifiedSettingsPatch } from "@ryco/shared/settingsOwnership";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { applySettingsUpdated, getServerConfig, useServerSettings } from "~/rpc/serverState";
import { updateEnvironmentServerSettings } from "~/environments/runtime";
import { useSettingsEditingScope, useSettingsTarget } from "~/settingsTarget";
import { toastManager } from "~/components/ui/toast";
import {
  __resetClientSettingsPersistenceForTests,
  addClientSettingsHydrationListener,
  addClientSettingsListener,
  clearClientSettingsHydrationPromise,
  getClientSettingsHydratedSnapshot,
  getClientSettingsSnapshot,
  readClientSettingsHydrationPromise,
  replaceClientSettingsSnapshot,
  setClientSettingsHydrated,
  writeClientSettingsHydrationPromise,
} from "./clientSettingsStore";

const CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE = "[CLIENT_SETTINGS]";

function subscribeClientSettings(listener: () => void): () => void {
  const unsubscribe = addClientSettingsListener(listener);
  void hydrateClientSettings();
  return unsubscribe;
}

function subscribeClientSettingsHydration(listener: () => void): () => void {
  const unsubscribe = addClientSettingsHydrationListener(listener);
  void hydrateClientSettings();
  return unsubscribe;
}

async function hydrateClientSettings(): Promise<void> {
  if (getClientSettingsHydratedSnapshot()) {
    return;
  }
  const currentHydrationPromise = readClientSettingsHydrationPromise();
  if (currentHydrationPromise) {
    return currentHydrationPromise;
  }

  const nextHydration = (async () => {
    try {
      const persistedSettings = await ensureLocalApi().persistence.getClientSettings();
      if (persistedSettings) {
        replaceClientSettingsSnapshot({
          ...DEFAULT_CLIENT_SETTINGS,
          ...persistedSettings,
        });
      }
    } catch (error) {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} hydrate failed`, error);
    } finally {
      setClientSettingsHydrated(true);
    }
  })();

  const hydrationPromise = nextHydration.finally(() => {
    clearClientSettingsHydrationPromise(hydrationPromise);
  });
  writeClientSettingsHydrationPromise(hydrationPromise);

  return hydrationPromise;
}

function persistClientSettings(settings: ClientSettings): void {
  replaceClientSettingsSnapshot(settings);
  void ensureLocalApi()
    .persistence.setClientSettings(settings)
    .catch((error) => {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} persist failed`, error);
    });
}

// ── Hooks ────────────────────────────────────────────────────────────

/**
 * Read merged settings. Selector narrows the subscription so components
 * only re-render when the slice they care about changes.
 */

/**
 * Non-hook accessor for the current merged client settings snapshot.
 * Used by non-React code paths (e.g. runtime services) that need the latest
 * settings without subscribing.
 */
export function getClientSettings(): ClientSettings {
  return getClientSettingsSnapshot();
}

export function useClientSettingsHydrated(): boolean {
  return useSyncExternalStore(
    subscribeClientSettingsHydration,
    getClientSettingsHydratedSnapshot,
    () => false,
  );
}

export function useSettings<T = UnifiedSettings>(selector?: (s: UnifiedSettings) => T): T {
  const serverSettings = useServerSettings();
  const clientSettings = useSyncExternalStore(
    subscribeClientSettings,
    getClientSettingsSnapshot,
    () => DEFAULT_CLIENT_SETTINGS,
  );

  const merged = useMemo<UnifiedSettings>(
    () => ({
      ...serverSettings,
      ...clientSettings,
    }),
    [clientSettings, serverSettings],
  );

  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

/**
 * Returns an updater that routes each key to the correct backing store.
 *
 * Server keys are optimistically patched in atom-backed server state, then
 * persisted via RPC. Client keys go through client persistence.
 */
export function useUpdateSettings() {
  const target = useSettingsTarget();
  const editingScope = useSettingsEditingScope();
  const targetEnvironmentId = target?.environmentId ?? null;
  const targetIsPrimary = target?.primary ?? true;
  const targetConnected = target?.connected ?? true;
  const updateSettings = useCallback(
    (patch: Partial<UnifiedSettings>) => {
      const { serverPatch, clientPatch } = splitUnifiedSettingsPatch(patch);

      const serverWriteAllowed =
        !(editingScope === "node" && !target) &&
        !(target && (!target.connected || target.canManage === false));
      if (editingScope !== "client" && serverWriteAllowed && Object.keys(serverPatch).length > 0) {
        if (targetEnvironmentId && !targetIsPrimary) {
          if (!targetConnected) {
            console.error(
              `[SETTINGS] Refused a node setting write while ${targetEnvironmentId} is disconnected.`,
            );
          } else {
            void updateEnvironmentServerSettings(targetEnvironmentId, serverPatch).catch(
              (error) => {
                console.error(`[SETTINGS] update failed for ${targetEnvironmentId}`, error);
                toastManager.add({
                  type: "error",
                  title: "Could not save node settings",
                  description: `Reconnect to ${target?.nodeLabel ?? "this node"} and try again.`,
                });
              },
            );
          }
        } else {
          const currentServerConfig = getServerConfig();
          if (currentServerConfig) {
            applySettingsUpdated(
              applyServerSettingsPatch(currentServerConfig.settings, serverPatch),
            );
          }
          // Fire-and-forget RPC — push will reconcile on success
          void ensureLocalApi().server.updateSettings(serverPatch);
        }
      }

      if (editingScope !== "node" && Object.keys(clientPatch).length > 0) {
        persistClientSettings({
          ...getClientSettingsSnapshot(),
          ...clientPatch,
        });
      }
    },
    [editingScope, target, targetConnected, targetEnvironmentId, targetIsPrimary],
  );

  const resetSettings = useCallback(() => {
    updateSettings(DEFAULT_UNIFIED_SETTINGS);
  }, [updateSettings]);

  return {
    updateSettings,
    resetSettings,
  };
}
export { __resetClientSettingsPersistenceForTests };
