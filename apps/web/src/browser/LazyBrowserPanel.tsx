import {
  preloadableLazy,
  useLazyComponentReady,
  type PreloadableModule,
} from "../lib/preloadableLazy";
import type { BrowserProject } from "./BrowserPanel";

/*
 * The browser panel renders synchronously once its chunk has loaded: a
 * `React.lazy` boundary committed its fallback on every first open and React
 * then held the panel for up to 300 ms (its Suspense reveal throttle). The
 * workspace tab bar and the live-preview trigger preload it on intent.
 */
const Panel = preloadableLazy(() => import("./BrowserPanel").then((module) => module.BrowserPanel));

/** The browser panel's chunk, for preload sites (the workspace panel's surface loaders). */
export const BrowserPanelChunk: PreloadableModule = Panel;

/** Pointer or focus intent toward a control that opens the browser panel. */
export function preloadBrowserPanel(): void {
  void Panel.preload();
}

export function LazyBrowserPanel(props: BrowserProject) {
  // Loading renders as an ordinary commit, which the panel replaces as soon as
  // its chunk lands; a failed load mounts the panel, which reports the error.
  const ready = useLazyComponentReady(Panel, true);
  if (!ready) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading browser…
      </p>
    );
  }
  return <Panel {...props} />;
}
