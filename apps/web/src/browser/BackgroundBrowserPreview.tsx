import type { BrowserProject } from "./BrowserPanel";
import { projectBrowserKey, useProjectBrowserTabs } from "./browserState";
import { preloadableLazy, useLazyComponentReady } from "../lib/preloadableLazy";

/** The capture loop and thumbnail: their own chunk, loaded once a background browser runs. */
const LazyBackgroundBrowserPreviewTile = preloadableLazy(() =>
  import("./BackgroundBrowserPreviewTile").then((module) => module.BackgroundBrowserPreviewTile),
);

/** The project's background browser as a thumbnail, when one runs. */
export function BackgroundBrowserPreview({
  environmentId,
  cwd,
  onOpen,
}: BrowserProject & { onOpen: () => void }) {
  const { selected, api } = useProjectBrowserTabs(projectBrowserKey(environmentId, cwd));
  const running = api !== undefined && selected !== null;
  const ready = useLazyComponentReady(LazyBackgroundBrowserPreviewTile, running);
  if (!running || !ready) return null;
  return <LazyBackgroundBrowserPreviewTile selected={selected} api={api} onOpen={onOpen} />;
}
