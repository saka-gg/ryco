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
import { useCallback, useContext, useSyncExternalStore } from "react";
import { RegistryContext } from "@effect/atom-react";

import type { ServerSettings } from "@ryco/contracts";
import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type ServerSettingsPatch,
  UnifiedSettings,
} from "@ryco/contracts/settings";
import { ensureLocalApi } from "~/localApi";
import { splitUnifiedSettingsPatch } from "@ryco/shared/settingsOwnership";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import {
  applySettingsUpdated,
  getServerConfig,
  selectSettings,
  serverConfigAtom,
} from "~/rpc/serverState";
import { updateEnvironmentServerSettings } from "~/environments/runtime";
import { useSettingsEditingScope, useSettingsTarget } from "~/settingsTarget";
import { toastManager } from "~/components/ui/toast";
import { useSyncExternalStoreSelector } from "./useSyncExternalStoreSelector";
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

/**
 * Optimistically applies a primary-node settings patch, then persists it. The push stream
 * reconciles a successful write; a rejected one is reported and replaced by the server's
 * current settings, or by the pre-write settings when those cannot be read either.
 */
function writePrimaryServerSettings(serverPatch: ServerSettingsPatch): void {
  const previousSettings = getServerConfig()?.settings ?? null;
  const optimisticSettings = previousSettings
    ? applyServerSettingsPatch(previousSettings, serverPatch)
    : null;
  if (optimisticSettings) {
    applySettingsUpdated(optimisticSettings);
  }
  void ensureLocalApi()
    .server.updateSettings(serverPatch)
    .catch(async (error: unknown) => {
      console.error("[SETTINGS] update failed", error);
      toastManager.add({
        type: "error",
        title: "Could not save settings",
        description: error instanceof Error ? error.message : "Your change was not saved.",
      });
      try {
        applySettingsUpdated(await ensureLocalApi().server.getSettings());
      } catch (refreshError) {
        console.error("[SETTINGS] could not reload settings after a failed update", refreshError);
        // Only undo our own optimistic write; a newer one has already replaced it.
        if (previousSettings && getServerConfig()?.settings === optimisticSettings) {
          applySettingsUpdated(previousSettings);
        }
      }
    });
}

// ── Hooks ────────────────────────────────────────────────────────────

/** Favorites are client-owned even when their control appears in node settings.
 * This field-specific writer cannot modify node configuration or other preferences.
 */
export function updateClientModelFavorites(
  update: (favorites: ClientSettings["favorites"]) => ClientSettings["favorites"],
): void {
  const settings = getClientSettingsSnapshot();
  persistClientSettings({ ...settings, favorites: update(settings.favorites) });
}

/**
 * This client's own auto-settle rule, which applies only to nodes that keep none
 * of their own. Client-owned in every settings scope, like the favorites above.
 */
export function updateClientAutoSettleAfterDays(
  value: ClientSettings["sidebarAutoSettleAfterDays"],
): void {
  persistClientSettings({ ...getClientSettingsSnapshot(), sidebarAutoSettleAfterDays: value });
}

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

// Merged settings are cached per (server, client) snapshot pair so every
// consumer of the same pair sees one object. Provider-status pushes replace
// the server config but keep its `settings` object, so they hit the cache.
const mergedSettingsCache = new WeakMap<ServerSettings, WeakMap<ClientSettings, UnifiedSettings>>();

function mergeSettings(serverSettings: ServerSettings, clientSettings: ClientSettings) {
  let byClient = mergedSettingsCache.get(serverSettings);
  if (byClient === undefined) {
    byClient = new WeakMap();
    mergedSettingsCache.set(serverSettings, byClient);
  }
  let merged = byClient.get(clientSettings);
  if (merged === undefined) {
    merged = { ...serverSettings, ...clientSettings };
    byClient.set(clientSettings, merged);
  }
  return merged;
}

function selectWholeSettings<T>(settings: UnifiedSettings): T {
  return settings as T;
}

/**
 * Read merged settings. The selector narrows the subscription: a component
 * re-renders only when its selected value changes (Object.is), not on every
 * server-config push (provider statuses churn during boot) or unrelated
 * setting. Select primitives or stable sub-objects; an object built inside the
 * selector is new on every change.
 */
export function useSettings<T = UnifiedSettings>(selector?: (s: UnifiedSettings) => T): T {
  const registry = useContext(RegistryContext);
  const target = useSettingsTarget();
  const hasTarget = target !== null;
  const targetServerConfig = target?.serverConfig ?? null;
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribeClient = subscribeClientSettings(listener);
      // An open settings surface's node config arrives through context.
      const unsubscribeServer = hasTarget
        ? undefined
        : registry.subscribe(serverConfigAtom, () => listener());
      return () => {
        unsubscribeClient();
        unsubscribeServer?.();
      };
    },
    [hasTarget, registry],
  );
  const getSnapshot = useCallback(
    () =>
      mergeSettings(
        selectSettings(hasTarget ? targetServerConfig : registry.get(serverConfigAtom)),
        getClientSettingsSnapshot(),
      ),
    [hasTarget, registry, targetServerConfig],
  );
  return useSyncExternalStoreSelector(subscribe, getSnapshot, selector ?? selectWholeSettings<T>);
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
          writePrimaryServerSettings(serverPatch);
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
