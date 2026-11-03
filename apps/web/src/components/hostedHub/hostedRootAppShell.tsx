import { Suspense } from "react";

import { preloadableLazy, useLazyComponentReady } from "../../lib/preloadableLazy";
import { AppBootLoadingSurface } from "../AppBootLoadingSurface";
import type { RootAppShellProps } from "../RootAppShell";

/**
 * The workspace shell, loaded on demand.
 *
 * The hosted root renders the workspace only for an authenticated account (or
 * a remembered-browser preview), so the sign-in, account and directory
 * surfaces never download and parse it. Once preloaded it renders on the first
 * pass with no suspension, so no Suspense fallback and no reveal throttle.
 */
const LazyRootAppShell = preloadableLazy<RootAppShellProps>(() =>
  import("../RootAppShell").then((module) => module.RootAppShell),
);

/**
 * Start (or join) loading the workspace shell. Never rejects: a failed load
 * surfaces from the next render, and the next call retries it.
 *
 * The boot gate calls this as soon as the access check says the shell will be
 * needed, in parallel with the hosted root's own chunk, so the common path — a
 * returning, signed-in browser — does not wait on a second download after the
 * root has mounted.
 */
export function preloadHostedRootAppShell(): Promise<void> {
  return LazyRootAppShell.preload();
}

/** The workspace shell as the hosted root renders it: loaded on demand, one element type. */
export function HostedRootAppShell(props: RootAppShellProps) {
  return (
    <Suspense fallback={<AppBootLoadingSurface />}>
      <LazyRootAppShell {...props} />
    </Suspense>
  );
}

// From the workspace shell's chunk, which an authenticated account preloads
// anyway, so the alerts add no chunk of their own.
const LazyThreadAlertsBootstrap = preloadableLazy(() =>
  import("../RootAppShell").then((module) => module.ThreadAlertsBootstrap),
);

/**
 * Thread alerts as the hosted root runs them: above its choice of surface, so
 * a Hub page, the node directory or a node switch surface that replaces the
 * workspace shell does not stop them while other nodes stay connected.
 */
export function HostedThreadAlerts() {
  const ready = useLazyComponentReady(LazyThreadAlertsBootstrap, true, {
    onLoadError: (error) => console.warn("Thread alerts failed to load.", error),
  });
  return ready ? <LazyThreadAlertsBootstrap /> : null;
}
