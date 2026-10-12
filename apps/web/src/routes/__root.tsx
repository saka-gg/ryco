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
import { runHostedBootGate } from "../hostedHub/bootGate";
import { getPresentationTier } from "../lib/presentationTier";
import { preloadableLazy, type PreloadableModule } from "../lib/preloadableLazy";
import { preloadMatchedRouteChunks } from "../lib/routeChunkPreload";
import { isPrimaryShellCacheEligible } from "../persistence/primaryShellCacheEligibility";
import { hostedPwaLifecycle } from "../pwa/lifecycle";
import { useHostedPwaSnapshot } from "../pwa/useHostedPwaSnapshot";
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
// File Preview drafts only exist once its (lazy) panel has opened, so the
// guard that protects them loads after the first render instead of with boot.
// It renders nothing, so its boundary never shows a fallback.
const PreviewFileNavigationGuard = lazy(() =>
  import("../components/PreviewFileNavigationGuard").then((module) => ({
    default: module.PreviewFileNavigationGuard,
  })),
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
      <Suspense fallback={null}>
        <PreviewFileNavigationGuard />
      </Suspense>
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

/** How long a boot waits for the cached primary shell before rendering without it. */
const PRIMARY_SHELL_CACHE_BOOT_WAIT_MS = 150;

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
    // The same preloadable module `RootRouteView` renders, so the root match
    // commits the hosted root directly instead of suspending on it once.
    // `preload()` never rejects; a failed chunk surfaces from the render.
    await runHostedBootGate({ pathname, hostedRoot: HostedHubRoot.preload() });
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

  // The primary environment's last-known shell is read while the auth and
  // descriptor requests are on the wire, so the sidebar can paint it before
  // the live snapshot arrives (see persistence/primaryShellCache).
  const keepsLocalCaches = isPrimaryShellCacheEligible({
    hostname: currentUrl.hostname,
    desktop: isElectron,
  });
  const primaryShellCache =
    keepsLocalCaches && pathname !== "/pair" && !isNativeAuthorizationPath(pathname)
      ? loadPrimaryShellCache()
      : null;
  // Provider catalogs this page already holds, so the config snapshot can
  // leave them out (loaded here, ahead of the first config subscription).
  const providerCatalogs = keepsLocalCaches ? attachProviderCatalogPersistence() : null;
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
  if (authGateState.status === "authenticated" && connectsEarly) {
    startPrimaryConnectionEarly();
    if (primaryShellCache !== null) await restorePrimaryShellCache(primaryShellCache);
  } else {
    discardPrefetchedPrimaryWebSocketToken();
    if (authGateState.status !== "authenticated") {
      // The server no longer accepts this browser's session: what it cached goes.
      void primaryShellCache?.then((loaded) => loaded?.cache.clearPrimaryShellCache());
      void providerCatalogs?.then((clear) => clear?.());
    }
  }
  markStartupPhase("root-before-load-ready");
  measureStartupPhase("root-before-load", "root-before-load-start", "root-before-load-ready");
  return {
    authGateState,
  };
}

/** Resolves to a function that drops the persisted catalogs, or `null` when unavailable. */
function attachProviderCatalogPersistence(): Promise<(() => Promise<void>) | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return Promise.all([
    import("@ryco/client-runtime/rpc"),
    import("../persistence/providerCatalogStore"),
  ])
    .then(async ([{ providerCatalogCache }, { createIndexedDbProviderCatalogStore }]) => {
      const store = createIndexedDbProviderCatalogStore({
        factory: indexedDB,
        origin: window.location.origin,
      });
      await providerCatalogCache.attachStore(store);
      return async () => {
        providerCatalogCache.clear();
        await store.clear().catch(() => undefined);
      };
    })
    .catch(() => null);
}

type PrimaryShellCacheModule = typeof import("../persistence/primaryShellCache");
interface LoadedPrimaryShellCache {
  readonly cache: PrimaryShellCacheModule;
  readonly value: unknown;
}

function loadPrimaryShellCache(): Promise<LoadedPrimaryShellCache | null> {
  return import("../persistence/primaryShellCache")
    .then(async (cache) => ({ cache, value: await cache.readPrimaryShellCache() }))
    .catch(() => null);
}

/**
 * Paints the cached primary shell (when the store has nothing live for it)
 * and starts keeping the cache current. Waits a bounded time for a slow read
 * rather than holding the boot on storage; a read that loses the race still
 * hydrates when it lands, unless live data has arrived by then.
 */
async function restorePrimaryShellCache(
  pending: Promise<LoadedPrimaryShellCache | null>,
): Promise<void> {
  const restore = pending.then(async (loaded) => {
    if (loaded === null) return;
    const { readPrimaryEnvironmentDescriptor } = await import("../environments/primary");
    const environmentId = readPrimaryEnvironmentDescriptor()?.environmentId;
    if (!environmentId) return;
    if (loaded.cache.hydratePrimaryShellFromCache({ value: loaded.value, environmentId })) {
      markStartupPhase("primary-shell-cache-hydrated");
    }
    loaded.cache.startPrimaryShellCachePersistence({ environmentId });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    restore.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PRIMARY_SHELL_CACHE_BOOT_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
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
  // A newer build waiting behind this page (a deploy replaced the chunk that
  // failed): "Reload app" switches to it, since a plain reload of a
  // service-worker-controlled page boots the cached build again.
  const updateState = useHostedPwaSnapshot(hostedPwaLifecycle)?.updateState ?? "idle";
  const message =
    updateState !== "idle"
      ? "A new version of the app is ready. Update to continue."
      : hosted
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
          <Button
            size="sm"
            variant="outline"
            disabled={updateState === "activating"}
            onClick={() =>
              hostedPwaLifecycle ? hostedPwaLifecycle.reloadApp() : window.location.reload()
            }
          >
            {updateState === "ready"
              ? "Update app"
              : updateState === "activating"
                ? "Updating…"
                : "Reload app"}
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
