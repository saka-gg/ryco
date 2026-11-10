import type { AppLifecycleService } from "../platform/index.ts";

/**
 * Whether this client is in the foreground, as the platform reports it (a visible tab or window,
 * an active phone app) and pushes it here. Connections tell nodes that support it, so a node can
 * hold back live output nobody looks at (`server.setConnectionVisibility`).
 */
export type ClientVisibility = "foreground" | "background";

let visibility: ClientVisibility = "foreground";
const listeners = new Set<(visibility: ClientVisibility) => void>();

export function readClientVisibility(): ClientVisibility {
  return visibility;
}

export function setClientVisibility(next: ClientVisibility): void {
  if (next === visibility) return;
  visibility = next;
  for (const listener of [...listeners]) listener(next);
}

export function subscribeClientVisibility(
  listener: (visibility: ClientVisibility) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Feeds the platform's foreground and background signals in (a hidden tab or minimized window on
 * the web and desktop, the app state on the phone). Returns the unbind.
 */
export function bindClientVisibility(
  lifecycle: Pick<AppLifecycleService, "isForeground" | "subscribe">,
): () => void {
  setClientVisibility(lifecycle.isForeground() ? "foreground" : "background");
  return lifecycle.subscribe((event) => {
    if (event === "background") setClientVisibility("background");
    else if (event === "foreground" || event === "resume") {
      setClientVisibility(lifecycle.isForeground() ? "foreground" : "background");
    }
  });
}
