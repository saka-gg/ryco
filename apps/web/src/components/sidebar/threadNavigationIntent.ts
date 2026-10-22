import type { ScopedThreadRef } from "@ryco/contracts";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import { selectThreadDetailLoaded } from "@ryco/client-runtime/state/threads";

import { isHostedHubMode } from "../../env";
import { retainThreadDetailSubscription } from "../../environments/runtime/service";
import { canPreconnectHostedEnvironment } from "../../hostedHub/hostedConnectionCoordinator";
import { retainHostedIntentScope } from "../../hostedHub/hostedConnectionScopes";
import { isHostedEnvironmentSessionAdoptable } from "../../hostedHub/state";
import { getPresentationTier } from "../../lib/presentationTier";
import { type AppRouteId, preloadRouteChunk } from "../../lib/routeChunkPreload";
import { markNodeSwitchIntent } from "../../perf/nodeSwitchInstrumentation";
import { useStore } from "../../store";
import {
  createNodePreconnect,
  createThreadNavigationIntents,
  mayPrefetchThreadWindow,
  type NavigationPressEvent,
} from "./threadNavigationIntent.logic";

const THREAD_ROUTE_ID = "/_chat/$environmentId/$threadId" satisfies AppRouteId;
const DRAFT_ROUTE_ID = "/_chat/draft/$draftId" satisfies AppRouteId;

const intents = createThreadNavigationIntents({
  // Every intent retain is speculative: a body only a hover or a press fetched
  // is the first the store drops.
  retain: (ref) =>
    retainThreadDetailSubscription(ref.environmentId, ref.threadId, { speculative: true }),
  isDetailLoaded: (ref) => selectThreadDetailLoaded(useStore.getState(), ref),
  // On hosted Web a hover or a press reads the thread's window only from a
  // session that is ready. Any other node is the press pre-connect's: an intent
  // retain would wait for that connection, or for anything else to connect it.
  canRetain: (ref) => {
    const hosted = isHostedHubMode();
    return mayPrefetchThreadWindow({
      hosted,
      phoneTier: hosted && getPresentationTier() === "phone",
      sessionReady: hosted && isHostedEnvironmentSessionAdoptable(ref.environmentId),
    });
  },
  preloadThreadRoute: () => void preloadRouteChunk(THREAD_ROUTE_ID),
  keyOf: scopedThreadKey,
});

// The frozen web phone tier gets no pre-connect.
const nodePreconnect = createNodePreconnect({
  enabled: () => isHostedHubMode() && getPresentationTier() !== "phone",
  needsConnection: canPreconnectHostedEnvironment,
  preconnect: (environmentId) => {
    retainHostedIntentScope(environmentId);
    markNodeSwitchIntent(environmentId, "press");
  },
});

/**
 * Whether a row's pointer press navigates (the primary button, no selection
 * modifier, not on a nested control). It also records the press, so the
 * {@link noteThreadPressIntent} that follows knows whether it may connect a
 * hosted node ahead of the navigation.
 */
export function isNavigationPress(event: NavigationPressEvent): boolean {
  return nodePreconnect.notePress(event);
}

/**
 * A thread row is hovered: warm its route, and retain its detail after a dwell
 * (on hosted Web only from a session that is ready, and never on the phone
 * tier).
 */
export function noteThreadHoverIntent(ref: ScopedThreadRef): void {
  intents.hover(ref);
}

export function noteThreadHoverEnd(ref: ScopedThreadRef): void {
  intents.leave(ref);
}

/**
 * A thread row is pressed: warm its route and retain its detail now (on hosted
 * Web only from a session that is ready, and never on the phone tier). On
 * hosted Web a navigation press on a node without a live session connects it
 * ahead of the navigation, within the pre-connect bounds; the thread's window
 * then starts with the route.
 */
export function noteThreadPressIntent(ref: ScopedThreadRef): void {
  intents.press(ref);
  nodePreconnect.press(ref);
}

/** A control that opens a draft (a new thread or a draft row) is about to be used. */
export function preloadDraftRoute(): void {
  void preloadRouteChunk(DRAFT_ROUTE_ID);
}
