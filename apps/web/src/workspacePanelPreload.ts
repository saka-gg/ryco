import { useEffect, type ComponentType } from "react";

import { preloadVscodeIconResolver } from "./hooks/useVscodeIconUrl";
import { scheduleIdleTask } from "./lib/idleTask";
import {
  preloadableLazy,
  useLazyComponentReady,
  type PreloadableLazyComponent,
  type PreloadableModule,
} from "./lib/preloadableLazy";
import type { RightPanelMode } from "./rightPanelRouteSearch";

/**
 * The code-split workspace panel and its surfaces, with shared preloads.
 *
 * Each one is a `preloadableLazy` component: a preload started on hover,
 * focus, idle or open and the eventual render share one request, and once the
 * chunk has resolved the component renders in its first pass. Mount points
 * gate on {@link useWorkspacePanelChunkReady} rather than a Suspense fallback,
 * so a cold open never waits on React's Suspense reveal throttle (the retry
 * commit is held until 300 ms after a committed fallback, however fast the
 * chunk lands). Without preloading the panel is a chunk waterfall (shell, then
 * surface, then the surface's static deps), so starting it before the click
 * hides one to three round trips. Preloading only fetches code: no PTY, RPC or
 * other side effect.
 */

function lazyPanel<P extends object>(
  load: () => Promise<{ readonly default: ComponentType<P> }>,
): PreloadableLazyComponent<P> {
  return preloadableLazy(() => load().then((module) => module.default));
}

type PanelModule = { readonly default: (props: never) => unknown };
/** A panel's props, named through its module type (not every panel exports them). */
type LazyPanel<Module extends PanelModule> = PreloadableLazyComponent<
  Parameters<Module["default"]>[0]
>;

export const LazyThreadWorkspacePanel: LazyPanel<
  typeof import("./components/ThreadWorkspacePanel")
> = lazyPanel(() => import("./components/ThreadWorkspacePanel"));
export const LazyDiffPanel: LazyPanel<typeof import("./components/DiffPanel")> = lazyPanel(
  () => import("./components/DiffPanel"),
);
export const LazyPreviewPanel: LazyPanel<typeof import("./components/PreviewPanel")> = lazyPanel(
  () => import("./components/PreviewPanel"),
);
export const LazyThreadTerminalDrawer: LazyPanel<
  typeof import("./components/ThreadTerminalDrawer")
> = lazyPanel(() => import("./components/ThreadTerminalDrawer"));
export const LazySimulatorPanel: LazyPanel<typeof import("./components/device/SimulatorPanel")> =
  lazyPanel(() => import("./components/device/SimulatorPanel"));
export const LazyWorkspacePullRequestPanel: LazyPanel<
  typeof import("./components/pullRequests/workspace/WorkspacePullRequestPanel")
> = lazyPanel(() => import("./components/pullRequests/workspace/WorkspacePullRequestPanel"));

/** Warms a panel chunk for whoever renders its component next. Never rejects. */
export interface PanelChunkPreload {
  (): Promise<void>;
  /** Whether the chunk has resolved, so a render will not suspend on it. */
  readonly isLoaded: () => boolean;
}

function preloadOf(chunk: PreloadableModule): PanelChunkPreload {
  return Object.assign(() => chunk.preload(), { isLoaded: chunk.isLoaded });
}

// Preload sites (hover, idle, prepare) take these, so they never need to
// import a component; the request is the component's own.
export const loadThreadWorkspacePanel = preloadOf(LazyThreadWorkspacePanel);
export const loadDiffPanel = preloadOf(LazyDiffPanel);
export const loadPreviewPanel = preloadOf(LazyPreviewPanel);
export const loadThreadTerminalDrawer = preloadOf(LazyThreadTerminalDrawer);
export const loadSimulatorPanel = preloadOf(LazySimulatorPanel);
export const loadWorkspacePullRequestPanel = preloadOf(LazyWorkspacePullRequestPanel);

const SURFACE_LOADERS: Partial<Record<RightPanelMode, PanelChunkPreload>> = {
  review: loadDiffPanel,
  files: loadPreviewPanel,
  terminal: loadThreadTerminalDrawer,
  simulator: loadSimulatorPanel,
  pullRequest: loadWorkspacePullRequestPanel,
};

const LOADING_LABELS: Record<RightPanelMode, string> = {
  review: "Loading diff viewer...",
  files: "Loading file preview...",
  terminal: "Loading terminal...",
  simulator: "Loading simulator...",
  browser: "Loading workspace...",
  pullRequest: "Loading pull request...",
  agents: "Loading agents...",
  agent: "Loading subagent thread...",
  render: "Loading page...",
};

/** The accessible label of the panel's loading state while `mode` loads. */
export function workspacePanelLoadingLabel(mode: RightPanelMode | null): string {
  return mode ? LOADING_LABELS[mode] : "Loading workspace...";
}

const ignoreFailure = () => undefined;

export interface WorkspacePanelPreloadOptions {
  /**
   * A pointer or focus intent toward the panel, or its actual open. Besides
   * code it may warm client-side resources that cost nothing on the server
   * (the diff highlight workers for review).
   */
  readonly intent?: boolean;
}

/** Starts the panel shell and the surface for `mode` in parallel. */
export function preloadWorkspacePanel(
  mode: RightPanelMode | null,
  options?: WorkspacePanelPreloadOptions,
): void {
  void loadThreadWorkspacePanel();
  const loadSurface = mode ? SURFACE_LOADERS[mode] : undefined;
  if (!loadSurface) {
    return;
  }
  void loadSurface();
  if (mode === "files") {
    // The file tree renders an icon per row; the lookup would otherwise only
    // start loading with the first row, after the entries arrive.
    preloadVscodeIconResolver();
  }
  if (mode === "review") {
    // The pool module sits one chunk level below the review surface; fetching
    // it alongside flattens the waterfall. Only an intent starts the workers.
    const loadPool = import("./lib/diffWorkerPool");
    if (options?.intent) {
      void loadPool.then((module) => module.prewarmDiffWorkerPool()).catch(ignoreFailure);
    } else {
      void loadPool.catch(ignoreFailure);
    }
  }
}

let workspacePanelModeHint: RightPanelMode | null = null;

/** The surface the workspace panel would show if it opened now. */
export function setWorkspacePanelPreloadHint(mode: RightPanelMode | null): void {
  workspacePanelModeHint = mode;
}

/** Hover or focus on a control that opens the workspace panel. */
export function preloadWorkspacePanelForIntent(): void {
  preloadWorkspacePanel(workspacePanelModeHint, { intent: true });
}

function prefersReducedData(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

const IDLE_PRELOAD_TIMEOUT_MS = 4_000;

/**
 * Fetches the panel code for `mode` once the page is idle, so the first open
 * in a session does not wait on the chunk waterfall. Skipped when the user
 * asked the browser to save data. Returns a cancel function.
 */
export function scheduleIdleWorkspacePanelPreload(mode: RightPanelMode | null): () => void {
  if (prefersReducedData()) {
    return () => undefined;
  }
  return scheduleIdleTask(() => preloadWorkspacePanel(mode), IDLE_PRELOAD_TIMEOUT_MS);
}

/**
 * Whether `chunk` (the panel shell or one of its surfaces) can mount without
 * suspending. Until it can, the caller renders its loading state as an
 * ordinary commit, which the surface replaces as soon as the chunk lands. A
 * preloaded chunk reports true on the first render, and a failed load does too
 * so the mount surfaces the error. Opening `mode` is an explicit intent: the
 * shell, the surface and its extras (the diff workers for review) start in
 * parallel instead of one after another.
 */
export function useWorkspacePanelChunkReady(
  chunk: PreloadableModule,
  mode: RightPanelMode | null,
): boolean {
  useEffect(() => {
    preloadWorkspacePanel(mode, { intent: true });
  }, [mode]);
  return useLazyComponentReady(chunk, true);
}
