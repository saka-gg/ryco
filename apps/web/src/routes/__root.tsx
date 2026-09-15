import { PreviewFileNavigationGuard } from "../components/PreviewFileNavigationGuard";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useLocation,
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
import {
  markInterstitialDismissed,
  readInterstitialDismissed,
  shouldShowPhoneAppInterstitial,
} from "../components/shell/phone/phoneAppInterstitial";
import { PhoneGetAppInterstitialBackdrop } from "../components/shell/phone/PhoneGetAppInterstitialBackdrop";

const RootAppShell = lazy(() =>
  import("../components/RootAppShell").then((module) => ({ default: module.RootAppShell })),
);
const HostedHubRoot = lazy(() =>
  import("../components/hostedHub/HostedHubRoot").then((module) => ({
    default: module.HostedHubRoot,
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
  beforeLoad: ({ location }) => resolveRootBeforeLoadContext(location.pathname),
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

function resolveRootBeforeLoadContext(
  pathname: string,
): RootBeforeLoadContext | Promise<RootBeforeLoadContext> {
  markStartupPhase("root-before-load-start");

  if (pathname !== "/pair" && cachedReadyRootContext) {
    markStartupPhase("root-before-load-ready");
    measureStartupPhase("root-before-load", "root-before-load-start", "root-before-load-ready");
    return cachedReadyRootContext;
  }

  if (pathname !== "/pair" && pendingReadyRootContext) {
    return pendingReadyRootContext;
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
    return context;
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
    const { installHostedConsoleBoundary } = await import("../hostedHub/logging");
    installHostedConsoleBoundary();
    const { ensureWebHostedRuntimeConfigured, hostedHubController } =
      await import("../hostedHub/state");
    ensureWebHostedRuntimeConfigured();
    await hostedHubController.bootstrap();
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

  const { ensurePrimaryEnvironmentReady, resolveInitialServerAuthGateState } =
    await import("../environments/primary");
  const [, authGateState] = await Promise.all([
    ensurePrimaryEnvironmentReady(),
    resolveInitialServerAuthGateState(),
  ]);
  markStartupPhase("root-before-load-ready");
  measureStartupPhase("root-before-load", "root-before-load-start", "root-before-load-ready");
  return {
    authGateState,
  };
}

function RootRoutePendingView() {
  return <AppBootLoadingSurface />;
}

function RootRouteView() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const nativeAuthorizationRoute = pathname.startsWith("/native/authorize/");
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
      <Suspense fallback={<AppBootLoadingSurface />}>
        <RootAppShell authGateState={authGateState} />
      </Suspense>
    </>
  );
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
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
          <Button size="sm" onClick={() => reset()}>
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
