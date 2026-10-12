import { PreviewFileNavigationGuard } from "../components/PreviewFileNavigationGuard";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import type { AuthSessionState } from "@ryco/contracts";

import { APP_DISPLAY_NAME } from "../branding";
import { AppBootLoadingSurface } from "../components/AppBootLoadingSurface";
import { Button } from "../components/ui/button";
import { markStartupPhase, measureStartupPhase } from "../perf/startupInstrumentation";
import {
  isElectron,
  isHostedHubMode,
  isPhoneAppInterstitialEnabled,
  readMobileAppUrl,
} from "../env";
import { getPresentationTier } from "../lib/presentationTier";
import { preloadableLazy, type PreloadableModule } from "../lib/preloadableLazy";
import { preloadMatchedRouteChunks } from "../lib/routeChunkPreload";
import {
  markInterstitialDismissed,
  readInterstitialDismissed,
  shouldShowPhoneAppInterstitial,
} from "../components/shell/phone/phoneAppInterstitial";
import { PhoneGetAppInterstitialBackdrop } from "../components/shell/phone/PhoneGetAppInterstitialBackdrop";

// The shell surfaces load during the root `beforeLoad` and render directly once
// resolved: a `React.lazy` boundary here committed its fallback on every boot
// and React then held the reveal for up to 300 ms (the Suspense throttle).
const RootAppShell = preloadableLazy(() =>
  import("../components/RootAppShell").then((module) => module.RootAppShell),
);
const HostedHubRoot = preloadableLazy(() =>
  import("../components/hostedHub/HostedHubRoot").then((module) => module.HostedHubRoot),
);
const PhoneGetAppInterstitial = lazy(() =>
  import("../components/shell/phone/PhoneGetAppInterstitial").then((module) => ({
    default: module.PhoneGetAppInterstitial,
  })),
);

export type RootAuthGateState =
  | { status: "authenticated" }
  | {
      status: "requires-auth";
      auth: AuthSessionState["auth"];
      errorMessage?: string;
    }
  | { status: "hosted-pairing" }
  | { status: "hosted-static" }
  | { status: "hosted-hub" };

export interface RootBeforeLoadContext {
  readonly authGateState: RootAuthGateState;
}

let cachedReadyRootContext: RootBeforeLoadContext | null = null;
let pendingReadyRootContext: Promise<RootBeforeLoadContext> | null = null;

export const Route = createRootRouteWithContext<Record<string, never>>()({
  beforeLoad: ({ location, preload }) => resolveRootBeforeLoadContext(location.pathname, preload),
  component: () => (
    <>
      <PreviewFileNavigationGuard />
      <RootRouteView />
    </>
  ),
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
  pendingComponent: RootRoutePendingView,
  pendingMinMs: 0,
  pendingMs: 0,
});

function isNativeAuthorizationPath(pathname: string): boolean {
  return pathname.startsWith("/native/authorize/");
}

/**
 * The lazily loaded surface `RootRouteView` renders for a gate state, or null
 * when it renders only the route outlet (pairing, native authorization, and
 * every unauthenticated state).
 */
function rootSurfaceFor(
  pathname: string,
  authGateState: RootAuthGateState,
): PreloadableModule | null {
  if (pathname === "/pair" || isNativeAuthorizationPath(pathname)) return null;
  switch (authGateState.status) {
    case "authenticated":
    case "hosted-static":
      return RootAppShell;
    case "hosted-hub":
      return HostedHubRoot;
    default:
      return null;
  }
}

/**
 * Resolves once the surface for `context` renders synchronously, so the root
 * match commits the shell itself rather than a Suspense fallback.
 */
function withRootSurfaceLoaded(
  pathname: string,
  context: RootBeforeLoadContext,
): RootBeforeLoadContext | Promise<RootBeforeLoadContext> {
  const surface = rootSurfaceFor(pathname, context.authGateState);
  if (!surface || surface.isLoaded()) return context;
  return surface.preload().then(() => {
    markStartupPhase("root-shell-module-ready");
    return context;
  });
}

function resolveRootBeforeLoadContext(
  pathname: string,
  preload: boolean,
): RootBeforeLoadContext | Promise<RootBeforeLoadContext> {
  // Intent preloads (hovering a link) run this too; the startup marks describe
  // navigations only, and must not pile up one entry per hover.
  if (!preload) markStartupPhase("root-before-load-start");

  if (pathname !== "/pair" && cachedReadyRootContext) {
    if (!preload) {
      markStartupPhase("root-before-load-ready");
      measureStartupPhase("root-before-load", "root-before-load-start", "root-before-load-ready");
    }
    return withRootSurfaceLoaded(pathname, cachedReadyRootContext);
  }

  if (pathname !== "/pair" && pendingReadyRootContext) {
    return pendingReadyRootContext;
  }

  if (pathname !== "/pair" && !isNativeAuthorizationPath(pathname)) {
    // Start the shell and the deep-linked page chunks alongside the auth round
    // trips. Nothing here waits for them yet: an unauthenticated document is
    // redirected to /pair without ever awaiting the shell graph.
    void (isHostedHubMode() ? HostedHubRoot : RootAppShell).preload();
    void preloadMatchedRouteChunks(pathname);
  }

  const pendingContext: Promise<RootBeforeLoadContext> = resolveRootBeforeLoadContextAsync(
    pathname,
  ).then((context) => {
    if (
      context.authGateState.status === "authenticated" ||
      context.authGateState.status === "hosted-static" ||
      context.authGateState.status === "hosted-hub"
    ) {
      cachedReadyRootContext = context;
    }
    return withRootSurfaceLoaded(pathname, context);
  });

  if (pathname !== "/pair") {
    const trackedPendingContext = pendingContext.finally(() => {
      if (pendingReadyRootContext === trackedPendingContext) {
        pendingReadyRootContext = null;
      }
    });
    pendingReadyRootContext = trackedPendingContext;
    return pendingReadyRootContext;
  }

  return pendingContext;
}

async function resolveRootBeforeLoadContextAsync(pathname: string): Promise<RootBeforeLoadContext> {
  const currentUrl = new URL(window.location.href);
  if (isHostedHubMode()) {
    // Code-only prefetches: fetching a chunk starts no session, ticket, relay
    // or store work, so the hosted root's graph and the workspace-owner module
    // download while the access check is on the wire instead of after it.
    // Each failure is settled here, so a chunk that fails to load while the
    // gate is still waiting is left for the route's own lazy load to report.
    // The same preloadable module `RootRouteView` renders, so the root match
    // commits the hosted root directly instead of suspending on it once.
    // `preload()` never rejects; a failed chunk surfaces from the render.
    const hostedRoot = HostedHubRoot.preload();
    const hostedRootAppShell = import("../components/hostedHub/hostedRootAppShell").catch(
      () => undefined,
    );
    const workspaceOwners = import("../hostedHub/hostedWorkspaceOwners").catch(() => undefined);
    const [
      { installHostedConsoleBoundary },
      { ensureWebHostedRuntimeConfigured, hostedHubController, hostedHubStore },
      { bootstrapWithHostedReadCache, canShowHostedReadPreview },
    ] = await Promise.all([
      import("../hostedHub/logging"),
      import("../hostedHub/state"),
      import("../hostedHub/readCache"),
    ]);
    installHostedConsoleBoundary();
    ensureWebHostedRuntimeConfigured();
    // Start the routed-node orchestrator, workspace coordinator and browser
    // lifecycle now, so route-derived demand reaches `selectNode` as soon as
    // the directory is ready rather than once the hosted root has mounted.
    // They only call into the hosted controller, which stays the one owner;
    // the root retains them as well, so a failed load here changes nothing.
    void workspaceOwners.then((owners) => {
      owners?.retainHostedWorkspaceOwners();
      owners?.prefetchHostedRouteCode(pathname);
    });
    // The gate waits for the account answer only. The directory has its own
    // loading and stale surfaces, and waiting for it held a stalled network on
    // the boot surface for a second request deadline.
    await bootstrapWithHostedReadCache(() => hostedHubController.bootstrapAccess());
    const needsWorkspaceShell =
      hostedHubStore.getState().accountStatus === "authenticated" || canShowHostedReadPreview();
    await Promise.all([
      hostedRoot,
      needsWorkspaceShell
        ? hostedRootAppShell.then((shell) =>
            shell?.preloadHostedRootAppShell().catch(() => undefined),
          )
        : undefined,
    ]);
    markStartupPhase("root-before-load-ready");
    return { authGateState: { status: "hosted-hub" } };
  }
  const { hasHostedPairingRequest, isHostedStaticApp } = await import("../hostedPairing");

  if (pathname === "/pair" && hasHostedPairingRequest(currentUrl)) {
    markStartupPhase("root-before-load-ready");
    return {
      authGateState: {
        status: "hosted-pairing",
      },
    };
  }

  if (isHostedStaticApp(currentUrl)) {
    const { waitForSavedEnvironmentRegistryHydration } = await import("../environments/runtime");
    await waitForSavedEnvironmentRegistryHydration();
    markStartupPhase("root-before-load-ready");
    return {
      authGateState: {
        status: "hosted-static",
      },
    };
  }

  const {
    discardPrefetchedPrimaryWebSocketToken,
    ensurePrimaryEnvironmentReady,
    prefetchPrimaryWebSocketToken,
    resolveInitialServerAuthGateState,
  } = await import("../environments/primary");
  const connectsEarly = !isNativeAuthorizationPath(pathname);
  // The first socket's ws-token round trip overlaps the session check. With a
  // valid session cookie it saves one round trip; without one it is a 401
  // that is dropped, and the socket asks again once a session exists.
  if (connectsEarly) prefetchPrimaryWebSocketToken();
  const [, authGateState] = await Promise.all([
    ensurePrimaryEnvironmentReady(),
    resolveInitialServerAuthGateState(),
  ]);
  markStartupPhase("root-before-load-ready");
  measureStartupPhase("root-before-load", "root-before-load-start", "root-before-load-ready");
  if (authGateState.status === "authenticated" && connectsEarly) {
    startPrimaryConnectionEarly();
  } else {
    discardPrefetchedPrimaryWebSocketToken();
  }
  return {
    authGateState,
  };
}

/**
 * Opens the primary connection as soon as the session is known, so the
 * ws-token round trip, the socket upgrade and the shell snapshot overlap the
 * shell chunk download instead of waiting for its first commit. Standard mode
 * only: hosted lifecycle recovery has a single owner and is never started from
 * here. The shell's `startEnvironmentConnectionService` stays the owner; the
 * supervisor's `connectPrimary` returns this same connection to it.
 */
function startPrimaryConnectionEarly(): void {
  void import("../environments/runtime")
    .then(({ connectPrimaryEnvironment }) => {
      connectPrimaryEnvironment();
    })
    .catch(() => undefined);
}

function RootRoutePendingView() {
  return <AppBootLoadingSurface />;
}

function RootRouteView() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const nativeAuthorizationRoute = isNativeAuthorizationPath(pathname);
  const { authGateState } = Route.useRouteContext();
  const canShowInterstitial =
    pathname !== "/pair" &&
    !nativeAuthorizationRoute &&
    (authGateState.status === "authenticated" ||
      authGateState.status === "hosted-static" ||
      authGateState.status === "hosted-hub");
  const [showInterstitial, setShowInterstitial] = useState(() => {
    if (!canShowInterstitial || !isPhoneAppInterstitialEnabled()) return false;
    return shouldShowPhoneAppInterstitial({
      enabled: true,
      isElectron,
      tier: getPresentationTier(),
      dismissed: readInterstitialDismissed(),
    });
  });

  useEffect(() => {
    let frame: number | null = null;
    let disposed = false;
    void import("../hooks/useTheme").then(({ syncBrowserChromeTheme }) => {
      if (disposed) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        syncBrowserChromeTheme();
      });
    });
    return () => {
      disposed = true;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [pathname]);

  const interstitial = showInterstitial ? (
    <Suspense fallback={<PhoneGetAppInterstitialBackdrop />}>
      <PhoneGetAppInterstitial
        appUrl={readMobileAppUrl()!}
        onDismiss={() => {
          markInterstitialDismissed();
          setShowInterstitial(false);
        }}
      />
    </Suspense>
  ) : null;

  if (pathname === "/pair" || nativeAuthorizationRoute) {
    return <Outlet />;
  }

  if (authGateState.status === "hosted-hub") {
    return (
      <>
        {interstitial}
        <Suspense fallback={<AppBootLoadingSurface />}>
          <HostedHubRoot />
        </Suspense>
      </>
    );
  }

  if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
    return <Outlet />;
  }

  return (
    <>
      {interstitial}
      {/* Loaded by `beforeLoad`; the boundary only covers a failed preload. */}
      <Suspense fallback={<AppBootLoadingSurface />}>
        <RootAppShell authGateState={authGateState} />
      </Suspense>
    </>
  );
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const hosted = isHostedHubMode();
  const message = hosted
    ? "The hosted client could not continue. Retry or reload the app."
    : errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6 phone:px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] phone:pt-[max(2.5rem,calc(env(safe-area-inset-top)+1rem))] phone:pb-[max(2.5rem,calc(env(safe-area-inset-bottom)+1rem))]">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => retryRootRoute(router, reset)}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        {!hosted ? (
          <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
              <span className="group-open:hidden">Show error details</span>
              <span className="hidden group-open:inline">Hide error details</span>
            </summary>
            <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
              {details}
            </pre>
          </details>
        ) : null}
      </section>
    </div>
  );
}

/**
 * "Try again" re-runs the root `beforeLoad`: the auth and environment reads
 * (which now fail with a timeout after their transient-retry budget instead of
 * hanging) and the shell chunk. Resetting the error boundary alone re-renders a
 * match that is still in its error state, which only shows this view again.
 * `invalidate` moves that match back to pending, and a shell chunk that failed
 * to load is retried by the same `beforeLoad`, which is the one place that
 * knows whether this session needs it.
 */
function retryRootRoute(router: ReturnType<typeof useRouter>, reset: () => void): void {
  void router.invalidate().finally(reset);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}
