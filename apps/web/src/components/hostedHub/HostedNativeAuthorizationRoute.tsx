import {
  CheckIcon,
  Loader2Icon,
  LogOutIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { NativeHandoffPresentation } from "@ryco/contracts/native-handoff";

import { APP_DISPLAY_NAME } from "../../branding";
import type * as HostedHubRootModule from "./HostedHubRoot";
import { hostedHubApi, HostedHubApiError } from "../../hostedHub/api";
import { hostedHubController, hostedHubStore, useHostedHubStore } from "../../hostedHub/state";
import { preloadableLazy, useLazyComponentReady } from "../../lib/preloadableLazy";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

// The sign-in surface lives in the hosted root's chunk, which a signed-in
// consent never needs. It renders synchronously once loaded: a `React.lazy`
// boundary committed its (empty) fallback and React then held the sign-in for
// up to 300 ms (its Suspense reveal throttle), even with the chunk cached.
const HostedAuthenticationSurface = preloadableLazy<
  NonNullable<ComponentProps<typeof HostedHubRootModule.HostedAuthenticationSurface>>
>(() => import("./HostedHubRoot").then((module) => module.HostedAuthenticationSurface));

/**
 * The route loader's preload: a signed-out browser needs the sign-in surface,
 * so its chunk loads before the route commits. A signed-in consent loads
 * nothing extra. Never rejects.
 */
export function preloadNativeAuthorizationSurface(): Promise<void> {
  return hostedHubStore.getState().accountStatus === "authenticated"
    ? Promise.resolve()
    : HostedAuthenticationSurface.preload();
}

/**
 * The sign-in surface's chunk alone, for a boot that expects a signed-out
 * browser before the access check has answered. Never rejects.
 */
export function preloadNativeAuthorizationSignIn(): Promise<void> {
  return HostedAuthenticationSurface.preload();
}

type ConsentAction = "approve" | "cancel" | "switch-account";

type ApprovedHandoff = {
  readonly redirectUri: string;
  readonly deviceLabel: string;
};

function navigateToNativeCallback(redirectUri: string): void {
  window.location.assign(redirectUri);
}

export function HostedNativeAuthorizationRoute({
  handoffId,
  navigate = navigateToNativeCallback,
}: {
  readonly handoffId: string;
  readonly navigate?: (redirectUri: string) => void;
}) {
  const accountStatus = useHostedHubStore((state) => state.accountStatus);
  const account = useHostedHubStore((state) => state.account);
  const [presentation, setPresentation] = useState<NativeHandoffPresentation | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<ConsentAction | null>(null);
  const [approvedHandoff, setApprovedHandoff] = useState<ApprovedHandoff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const authenticationSurfaceReady = useLazyComponentReady(
    HostedAuthenticationSurface,
    accountStatus !== "authenticated" || !account,
  );

  useEffect(() => {
    const operation = new AbortController();
    setLoading(true);
    setError(null);
    void hostedHubApi
      .getNativeHandoffPresentation(handoffId, operation.signal)
      .then((next) => setPresentation(next))
      .catch((cause: unknown) => {
        if (operation.signal.aborted) return;
        setError(
          cause instanceof HostedHubApiError
            ? cause.message
            : "This device authorization is unavailable or has expired.",
        );
      })
      .finally(() => {
        if (!operation.signal.aborted) setLoading(false);
      });
    return () => operation.abort();
  }, [handoffId]);

  useEffect(() => {
    if (!loading && accountStatus === "authenticated") {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [accountStatus, loading]);

  if (accountStatus !== "authenticated" || !account) {
    // Blank until the sign-in chunk lands (the loader usually preloaded it); a
    // failed load mounts the surface, which reports the error.
    return authenticationSurfaceReady ? (
      <HostedAuthenticationSurface
        context="native-authorization"
        autoExternalProvider={presentation?.providerHint ?? null}
      />
    ) : null;
  }

  const run = async (nextAction: ConsentAction) => {
    if (action !== null) return;
    setAction(nextAction);
    setError(null);
    try {
      if (nextAction === "switch-account") {
        await hostedHubController.signOut();
        return;
      }
      const result =
        nextAction === "approve"
          ? await hostedHubApi.approveNativeHandoff(handoffId)
          : await hostedHubApi.cancelNativeHandoff(handoffId);
      if (nextAction === "approve") {
        setApprovedHandoff({
          redirectUri: result.redirectUri,
          deviceLabel: presentation?.deviceLabel ?? "your device",
        });
        // Commit the success surface before asking the browser to open the
        // custom scheme. Safari keeps this tab alive, so it should visibly
        // acknowledge approval instead of leaving the consent button frozen.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      navigate(result.redirectUri);
    } catch (cause) {
      if (nextAction === "approve") setApprovedHandoff(null);
      setError(
        cause instanceof HostedHubApiError
          ? cause.message
          : "The device authorization could not be completed.",
      );
    } finally {
      setAction(null);
    }
  };

  if (approvedHandoff !== null) {
    return (
      <main className="flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
        <section
          role="status"
          aria-live="polite"
          className="w-full max-w-md rounded-[1.5rem] border border-border bg-card p-6 text-center shadow-2xl shadow-black/10 sm:p-8"
        >
          <div className="relative mx-auto flex size-24 items-center justify-center">
            <span
              aria-hidden
              className="absolute inset-2 rounded-full bg-success/20 motion-safe:animate-ping"
            />
            <span
              aria-hidden
              className="absolute inset-0 rounded-full border border-success/25 motion-safe:animate-pulse"
            />
            <span className="relative flex size-16 items-center justify-center rounded-full bg-success text-success-foreground shadow-lg shadow-success/20">
              <CheckIcon aria-hidden className="size-8" strokeWidth={2.5} />
            </span>
          </div>

          <p className="mt-7 text-[11px] font-semibold tracking-[0.16em] text-success uppercase">
            Sign-in approved
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Ryco is opening</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Ryco is securely finishing account and node setup on {approvedHandoff.deviceLabel}. This
            tab can be closed when the app shows setup complete.
          </p>

          <div className="mt-7 rounded-2xl border border-border bg-background/65 p-4">
            <div className="flex items-center justify-center gap-2 text-sm font-medium">
              <SmartphoneIcon aria-hidden className="size-4 text-primary" />
              Waiting for the Ryco app
              <span className="flex gap-1" aria-hidden>
                <span className="size-1 rounded-full bg-primary motion-safe:animate-pulse" />
                <span className="size-1 rounded-full bg-primary motion-safe:animate-pulse [animation-delay:150ms]" />
                <span className="size-1 rounded-full bg-primary motion-safe:animate-pulse [animation-delay:300ms]" />
              </span>
            </div>
          </div>

          <Button
            size="lg"
            variant="outline"
            className="mt-5 min-h-11 w-full"
            onClick={() => navigate(approvedHandoff.redirectUri)}
          >
            Open Ryco again
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center overflow-x-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <section className="w-full max-w-md rounded-[1.5rem] border border-border bg-card p-5 shadow-2xl shadow-black/10 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-primary">
            <ShieldCheckIcon aria-hidden className="size-5" />
          </div>
          <p className="pt-1 text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            {APP_DISPLAY_NAME} Hub
          </p>
        </div>

        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mt-6 text-2xl font-semibold tracking-tight outline-none"
        >
          Continue on this device?
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Only continue if you started this connection from the Ryco app. The app receives a
          one-time code, never this browser session.
        </p>

        <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-background/65">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
            <SmartphoneIcon aria-hidden className="size-5 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Requesting device</p>
              <p className="truncate text-sm font-medium">
                {loading ? "Checking request…" : (presentation?.deviceLabel ?? "Unknown device")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 px-4 py-3.5">
            <div
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold text-primary"
            >
              {account.displayName.trim().slice(0, 1).toLocaleUpperCase() || "R"}
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Signed in as</p>
              <p className="truncate text-sm font-medium">{account.displayName}</p>
            </div>
          </div>
        </div>

        {error ? (
          <Alert variant="error" className="mt-4">
            <TriangleAlertIcon aria-hidden />
            <AlertTitle>Authorization did not complete</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="mt-6 space-y-2.5">
          <Button
            size="lg"
            className="min-h-11 w-full"
            disabled={loading || !presentation || action !== null}
            onClick={() => void run("approve")}
          >
            {action === "approve" ? (
              <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" />
            ) : (
              <CheckIcon aria-hidden />
            )}
            Continue as {account.displayName}
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="min-h-11 w-full"
            disabled={action !== null}
            onClick={() => void run("switch-account")}
          >
            {action === "switch-account" ? (
              <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" />
            ) : (
              <LogOutIcon aria-hidden />
            )}
            Use another account
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className="min-h-11 w-full"
            disabled={loading || !presentation || action !== null}
            onClick={() => void run("cancel")}
          >
            {action === "cancel" ? (
              <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" />
            ) : (
              <XIcon aria-hidden />
            )}
            Cancel
          </Button>
        </div>

        <p className="mt-5 text-center text-xs leading-relaxed text-muted-foreground">
          Access remains limited to the nodes and permissions assigned to this Hub account.
        </p>
      </section>
    </main>
  );
}
