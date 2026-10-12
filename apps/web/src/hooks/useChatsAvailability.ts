import { RegistryContext } from "@effect/atom-react";
import { getServerConfig, serverConfigAtom } from "@ryco/client-runtime/rpc";
import {
  resolveChatsAvailability,
  type ChatsAvailability,
} from "@ryco/client-runtime/state/composer";
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import { useCallback, useContext, useMemo } from "react";

import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import type { PresentationTier } from "../lib/presentationTier";
import { usePresentationTier } from "./usePresentationTier";
import { useSyncExternalStoreSelector } from "./useSyncExternalStoreSelector";

const selectWholeServerConfig = (config: ServerConfig | null): ServerConfig | null => config;

/**
 * The live server config of one environment: the primary connection's atom,
 * or a saved environment's runtime snapshot. Null while unknown. Re-renders on
 * every config push; hot components should use
 * {@link useEnvironmentServerConfigSelector}.
 */
export function useEnvironmentServerConfig(
  environmentId: EnvironmentId | null | undefined,
): ServerConfig | null {
  return useEnvironmentServerConfigSelector(environmentId, selectWholeServerConfig);
}

/**
 * Narrow subscription to one environment's live server config (null while
 * unknown): re-renders only when `selector`'s result changes (Object.is), not
 * on every config push, which includes each provider-status probe. Pass a
 * stable (module-level) selector that returns the same value for an unchanged
 * config.
 */
export function useEnvironmentServerConfigSelector<T>(
  environmentId: EnvironmentId | null | undefined,
  selector: (config: ServerConfig | null) => T,
): T {
  const registry = useContext(RegistryContext);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isPrimary = Boolean(environmentId) && environmentId === primaryEnvironmentId;
  const subscribePrimary = useCallback(
    (listener: () => void) =>
      isPrimary ? registry.subscribe(serverConfigAtom, () => listener()) : () => undefined,
    [isPrimary, registry],
  );
  const readPrimary = useCallback(
    () => (isPrimary ? registry.get(serverConfigAtom) : null),
    [isPrimary, registry],
  );
  const primarySelection = useSyncExternalStoreSelector(subscribePrimary, readPrimary, selector);
  const savedSelection = useSavedEnvironmentRuntimeStore((state) =>
    selector(
      environmentId && !isPrimary ? (state.byId[environmentId]?.serverConfig ?? null) : null,
    ),
  );
  return isPrimary ? primarySelection : savedSelection;
}

/** Non-reactive read of {@link useEnvironmentServerConfig}, for event handlers. */
export function readEnvironmentServerConfig(
  environmentId: EnvironmentId | null | undefined,
): ServerConfig | null {
  if (!environmentId) return null;
  if (environmentId === readPrimaryEnvironmentDescriptor()?.environmentId) {
    return getServerConfig();
  }
  return useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig ?? null;
}

const PHONE_TIER_CHATS_UNAVAILABLE: ChatsAvailability = {
  available: false,
  reason: "unsupported",
  message:
    "Chats without a project cannot start in the phone layout. Open Ryco in a wider window to start one.",
};

/**
 * Whether chats can start in this presentation. The frozen web phone tier
 * offers no chat entry points (the native app is the phone surface; see
 * AGENTS.md), whatever the node supports, just as it offers no promotion.
 */
export function chatsAvailabilityForTier(
  availability: ChatsAvailability,
  tier: PresentationTier,
): ChatsAvailability {
  return tier === "phone" && availability.available ? PHONE_TIER_CHATS_UNAVAILABLE : availability;
}

/**
 * Whether "No project" chats can start on an environment. Every chat entry
 * point reads this; a node without the capability, or the phone tier, hides
 * them entirely.
 */
export function useChatsAvailability(
  environmentId: EnvironmentId | null | undefined,
): ChatsAvailability {
  const config = useEnvironmentServerConfig(environmentId);
  const tier = usePresentationTier();
  const chats = config?.chats;
  return useMemo(
    () => chatsAvailabilityForTier(resolveChatsAvailability(chats ? { chats } : null), tier),
    [chats, tier],
  );
}
