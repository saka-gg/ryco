import { useAtomValue } from "@effect/atom-react";
import { serverConfigAtom } from "@ryco/client-runtime/rpc";
import {
  resolveChatsAvailability,
  type ChatsAvailability,
} from "@ryco/client-runtime/state/composer";
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import type { PresentationTier } from "../lib/presentationTier";
import { usePresentationTier } from "./usePresentationTier";

/**
 * The live server config of one environment: the primary connection's atom,
 * or a saved environment's runtime snapshot. Null while unknown.
 */
export function useEnvironmentServerConfig(
  environmentId: EnvironmentId | null | undefined,
): ServerConfig | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryConfig = useAtomValue(serverConfigAtom);
  const savedConfig = useSavedEnvironmentRuntimeStore((state) =>
    environmentId ? (state.byId[environmentId]?.serverConfig ?? null) : null,
  );
  if (!environmentId) return null;
  return environmentId === primaryEnvironmentId ? primaryConfig : savedConfig;
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
