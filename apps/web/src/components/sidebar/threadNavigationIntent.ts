import type { ScopedThreadRef } from "@ryco/contracts";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import { selectThreadDetailLoaded } from "@ryco/client-runtime/state/threads";

import { retainThreadDetailSubscription } from "../../environments/runtime/service";
import { type AppRouteId, preloadRouteChunk } from "../../lib/routeChunkPreload";
import { useStore } from "../../store";
import { createThreadNavigationIntents } from "./threadNavigationIntent.logic";

export { isNavigationPress } from "./threadNavigationIntent.logic";

const THREAD_ROUTE_ID = "/_chat/$environmentId/$threadId" satisfies AppRouteId;
const DRAFT_ROUTE_ID = "/_chat/draft/$draftId" satisfies AppRouteId;

const intents = createThreadNavigationIntents({
  retain: (ref) => retainThreadDetailSubscription(ref.environmentId, ref.threadId),
  isDetailLoaded: (ref) => selectThreadDetailLoaded(useStore.getState(), ref),
  preloadThreadRoute: () => void preloadRouteChunk(THREAD_ROUTE_ID),
  keyOf: scopedThreadKey,
});

/** A thread row is hovered: warm its route, and retain its detail after a dwell. */
export function noteThreadHoverIntent(ref: ScopedThreadRef): void {
  intents.hover(ref);
}

export function noteThreadHoverEnd(ref: ScopedThreadRef): void {
  intents.leave(ref);
}

/** A thread row is pressed: warm its route and retain its detail now. */
export function noteThreadPressIntent(ref: ScopedThreadRef): void {
  intents.press(ref);
}

/** A control that opens a draft (a new thread or a draft row) is about to be used. */
export function preloadDraftRoute(): void {
  void preloadRouteChunk(DRAFT_ROUTE_ID);
}
