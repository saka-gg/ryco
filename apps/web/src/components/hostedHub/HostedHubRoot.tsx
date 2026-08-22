import { useNavigate } from "@tanstack/react-router";
import type { ExternalIdentityPendingResponse } from "@ryco/contracts/hosted-identity";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  LifeBuoyIcon,
  Loader2Icon,
  LogOutIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  UserRoundIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";

import { RootAppShell } from "../RootAppShell";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Input, TOUCH_INPUT_CLASS_NAME } from "../ui/input";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { formatRecoveryCodesForClipboard } from "../settings/AccountSettings.logic";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  HOSTED_SESSION_SYNC_FAILURE_MESSAGE,
  hostedHubController,
  useHostedAccountStore,
  useHostedHubStore,
  useHostedRecoveryCodeDisplayStore,
} from "../../hostedHub/state";
import { hostedHubApi, HostedHubApiError } from "../../hostedHub/api";
import {
  consumeHostedIdentityLink,
  type HostedIdentityLink,
} from "../../hostedHub/hostedIdentityLinks";
import {
  hubRoutePathname,
  hubRouteTitle,
  navigateHub,
  useHubRoute,
} from "../../hostedHub/hubRoutes";
import { hubPageTitle } from "../../hubBranding";
import {
  selectHostedNodeRoute,
  useHostedNodeRouteNotice,
  useHostedNodeRouteOrchestrator,
  useRoutedHostedNode,
} from "../../hostedHub/nodeRouteOrchestrator";
import type { HostedHubNode } from "../../hostedHub/types";
import { useHostedBrowserLifecycle } from "../../hostedHub/useHostedBrowserLifecycle";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { PHONE_ANCHORED_ACTIONS_CLASS_NAME } from "../mobile/phoneAnchoredActions";
import { GitHubIcon } from "../Icons";
import {
  HostedConnectionControl,
  NodePresence,
  useHostedConnectionActions,
} from "./HostedConnectionControls";
import { HostedNodeDetail } from "./HostedNodeDetail";
import { HubAccountPage } from "./HubAccountPage";
import { HubGateway } from "./shell/HubGateway";
import { HubPage } from "./shell/HubPage";
import { HubShell } from "./shell/HubShell";
import {
  directoryCountLine,
  lastSeenLabel,
  nodeMetaLine,
  nodeSelectionBlocked,
  sortNodes,
} from "./HostedNodeDisplay.logic";
import { HostedNodeEnrollmentFlow } from "./HostedNodeEnrollment";
import { hostedNodeRevokedNotice, HOSTED_NODE_REVOKE_REASON_CODE } from "./HostedNodeRevoke.logic";
import { HostedPwaControls } from "./HostedPwaControls";
import {
  ExternalIdentitySignupFlow,
  PasswordLoginFlow,
  PasswordResetFlow,
  PublicSignupFlow,
  RecoveryCodeFlow,
  usePublicSignupConfiguration,
} from "./PublicAccountFlows";
import {
  beginGitHubAuthorization,
  externalIdentityPendingErrorMessage,
  githubProviderPolicy,
} from "./ExternalIdentityWeb.logic";
import { HostedRelayTrustNotice } from "./HostedRelayTrustNotice";

// Browser suites and callers keep importing the menu from the hosted root.
export { HostedNodeMenu } from "./HostedConnectionControls";

type EmailVerificationLink = Extract<
  HostedIdentityLink,
  { readonly kind: "email-verification" | "invalid-email-verification" }
>;

// React can evaluate a newly loaded root more than once before effects run. Scrubbing during the
// first evaluation must not make the second reinterpret the same navigation as an invalid link.
let pendingEmailVerificationLink: EmailVerificationLink | null | undefined;

function consumeInitialEmailVerificationLink(): EmailVerificationLink | null {
  if (window.location.pathname !== "/email-verification") return null;
  if (pendingEmailVerificationLink !== undefined) return pendingEmailVerificationLink;
  const consumed = consumeHostedIdentityLink({
    href: window.location.href,
    historyState: window.history.state,
    replaceState: (state, unused, url) => window.history.replaceState(state, unused, url),
  });
  pendingEmailVerificationLink =
    consumed?.kind === "email-verification" || consumed?.kind === "invalid-email-verification"
      ? consumed
      : null;
  return pendingEmailVerificationLink;
}

/*
 * `HostedEntryChrome` is gone, and with it the second `LazySettingsDialogMount`.
 *
 * It existed because a hosted user with zero, offline or revoked nodes never
 * reached `AppSidebarLayout` — the dialog's only other mount — and so could not
 * open account settings at all: `openSettings` is a global singleton and
 * flipped silently against no mount. Its toast providers were equally load
 * bearing, because the two sections a node-less session could reach both raise
 * toasts.
 *
 * Both needs are answered by construction now. Account and appearance are Hub
 * *pages* (`HubAccountPage`), so nothing on a node-less surface opens the node
 * app's settings dialog, and `HubShell` mounts the toast hosts for every
 * signed-in Hub page. The dialog keeps exactly one mount, in `AppSidebarLayout`,
 * reachable only from inside a node session where its node-scoped sections
 * mean something — which makes the old "never add a third mount" invariant
 * simply "there is one".
 */

/**
 * Names the page in the title bar, browser history and password-manager
 * prompts.
 *
 * The hosted build used to set one static title for the entire site, so every
 * Hub page appeared in history under the same name and a password manager had
 * no page to associate a credential with.
 */
function useHubDocumentTitle(): void {
  const route = useHubRoute();
  useEffect(() => {
    document.title = hubPageTitle(route === null ? undefined : hubRouteTitle(route));
  }, [route]);
}

export function HostedHubRoot() {
  const [emailVerificationLink, setEmailVerificationLink] = useState<EmailVerificationLink | null>(
    consumeInitialEmailVerificationLink,
  );
  const accountStatus = useHostedHubStore((state) => state.accountStatus);
  const selectedNode = useHostedHubStore((state) => state.selectedNode);
  const recoveryCodes = useHostedHubStore((state) => state.recoveryCodes);
  const transportStatus = useHostedHubStore((state) => state.transportStatus);
  const sessionEstablished = useHostedHubStore((state) => state.sessionEstablished);
  const errorMessage = useHostedHubStore((state) => state.errorMessage);
  const recoveryCodesLeased = useHostedRecoveryCodeDisplayStore((state) => state.leased);
  const routedNode = useRoutedHostedNode();
  useHostedNodeRouteOrchestrator();
  // The single browser lifecycle owner, above the presentation-tier seam: the
  // tier shells mount no lifecycle listeners of their own.
  useHostedBrowserLifecycle();
  useHubDocumentTitle();
  const hubRoute = useHubRoute();

  useEffect(() => {
    // GitHub authentication returns to account completion so an unlinked
    // identity can continue without another click. A linked identity establishes
    // a session instead, so replace that transient destination with the directory.
    if (accountStatus === "authenticated" && hubRoute?.kind === "sign-up") {
      navigateHub({ kind: "nodes" }, { replace: true });
    }
  }, [accountStatus, hubRoute]);

  if (
    emailVerificationLink?.kind === "email-verification" ||
    emailVerificationLink?.kind === "invalid-email-verification"
  ) {
    return (
      <HostedEmailVerificationSurface
        link={emailVerificationLink}
        onContinue={() => {
          window.history.replaceState(window.history.state, "", "/");
          setEmailVerificationLink(null);
        }}
      />
    );
  }

  // No shell: there is no account to configure yet.
  if (accountStatus !== "authenticated") return <HostedAuthenticationSurface />;
  // The post-bootstrap "save your codes" step owns the viewport because at that
  // point there is no shell to show it inside. Once a surface within the running
  // app is displaying them — account settings regenerating them — taking the
  // viewport would tear that surface down mid-flow, so the lease wins.
  //
  // It is also the safety net for a set of codes whose display went away
  // without an acknowledgement: they stay in the runtime's slot, so this takes
  // over and puts them in front of the user rather than leaving the account
  // holding codes its owner never saw.
  //
  // Owns the viewport unwrapped by any shell: this is a one-shot secret
  // display and nothing may compete with its acknowledgement.
  if (recoveryCodes.length > 0 && !recoveryCodesLeased) return <RecoveryCodesSurface />;
  // Account management is a Hub page, above the node gates: it is about the
  // account rather than any node, so it is reachable with none selected, with
  // one connecting, and from inside a node session.
  if (hubRoute?.kind === "account") return <HubAccountPage section={hubRoute.section} />;
  if (!selectedNode) {
    // A routed node segment is pending fail-closed validation: keep the UI on
    // a read-only restoring surface instead of flashing the directory. The
    // orchestrator either selects the node or clears the segment.
    if (routedNode.nodeId !== null) {
      return <HostedNodeRestoringSurface />;
    }
    return <HostedNodeDirectory />;
  }
  if (transportStatus === "terminal-failure") {
    return <HostedNodeFailureSurface node={selectedNode} message={errorMessage} />;
  }
  if (!sessionEstablished) {
    return <HostedNodeStartingSurface node={selectedNode} />;
  }

  // The hosted connection controls render inside the shell (workspace header
  // on desktop, app-bar pill on the phone tier) — never as a floating overlay.
  return <RootAppShell authGateState={{ status: "hosted-hub" }} />;
}

function HostedEmailVerificationSurface({
  link,
  onContinue,
}: {
  readonly link: Extract<
    HostedIdentityLink,
    { readonly kind: "email-verification" | "invalid-email-verification" }
  >;
  readonly onContinue: () => void;
}) {
  const [status, setStatus] = useState<"verifying" | "verified" | "invalid">(
    link.kind === "email-verification" ? "verifying" : "invalid",
  );

  useEffect(() => {
    if (link.kind !== "email-verification") return;
    const operation = new AbortController();
    void hostedHubApi
      .confirmEmailVerification(link.token, operation.signal)
      .then(() => setStatus("verified"))
      .catch(() => {
        if (!operation.signal.aborted) setStatus("invalid");
      })
      .finally(() => {
        pendingEmailVerificationLink = undefined;
      });
    return () => operation.abort();
  }, [link]);

  return (
    <HubGateway
      title={
        status === "verifying"
          ? "Verifying your email"
          : status === "verified"
            ? "Email verified"
            : "This verification link is unavailable"
      }
      description={
        status === "verifying"
          ? "This will only take a moment."
          : status === "verified"
            ? "Your address is now available for account recovery."
            : "The link is incomplete, expired, or has already been used. Request a new one from Account settings."
      }
      actions={
        status === "verifying" ? undefined : (
          <Button size="cta" className="mt-6 w-full" onClick={onContinue}>
            Continue
          </Button>
        )
      }
    >
      {status === "verifying" ? (
        <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
          <InlineProgress />
          Confirming the link…
        </p>
      ) : null}
    </HubGateway>
  );
}

/**
 * The in-paragraph progress glyph for a surface that is waiting.
 *
 * Deliberately `Loader2Icon` rather than `ui/spinner.tsx`: `Spinner` hardcodes
 * `role="status"` and `aria-label="Loading"`, and these paragraphs are already
 * live regions — nesting one inside the other creates a second region and a
 * duplicate announcement of a state that is being announced properly.
 */
function InlineProgress() {
  return (
    <Loader2Icon
      aria-hidden
      className="mr-2 inline size-4 animate-spin align-[-0.15em] motion-reduce:animate-none"
    />
  );
}

function HostedNodeFailureSurface({
  node,
  message,
}: {
  readonly node: HostedHubNode;
  readonly message: string | null;
}) {
  return (
    // The connection control already carries "All nodes", "Refresh", "Account"
    // and "Sign out", so the terminal-failure state needs no escape of its own.
    // It moves into the Hub bar rather than floating above the message, which
    // is where a page-level control belongs.
    <HubShell measure="content" trailing={<HostedConnectionControl />}>
      <HubStatus
        tone="destructive"
        icon={<TriangleAlertIcon aria-hidden className="size-8 text-destructive" />}
        title={`Unable to connect to ${node.label}`}
      >
        <p role="alert" className="text-muted-foreground text-sm">
          {message ?? "The relay session could not be established. Choose another node or retry."}
        </p>
        {message === HOSTED_SESSION_SYNC_FAILURE_MESSAGE ? (
          <Button className="mt-5" onClick={() => void hostedHubController.retrySelectedNode()}>
            <RefreshCwIcon aria-hidden /> Retry
          </Button>
        ) : null}
      </HubStatus>
    </HubShell>
  );
}

/**
 * A centred status page for the Hub's transitional and terminal states —
 * restoring, connecting, failed.
 *
 * These are not forms and not lists, so they take neither the gateway's panel
 * nor a page header: a glyph, a sentence about what is happening, and at most
 * one action, centred in the page's measure.
 */
function HubStatus({
  children,
  icon,
  title,
  tone = "default",
}: {
  readonly children: React.ReactNode;
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly tone?: "default" | "destructive";
}) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center pt-10 text-center">
      {icon}
      <h1
        className={`mt-4 font-semibold text-2xl tracking-tight ${
          tone === "destructive" ? "text-foreground" : ""
        }`}
      >
        {title}
      </h1>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function HostedNodeRestoringSurface() {
  // No escape here on purpose: this is a single-round-trip fail-closed
  // validation whose URL the route orchestrator owns, and an escape would race
  // the reconcile.
  return (
    <HubShell measure="content">
      <HubStatus
        icon={<ServerIcon aria-hidden className="size-8 text-primary" />}
        title="Restoring your node"
      >
        <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
          <InlineProgress />
          Checking your access before reconnecting…
        </p>
      </HubStatus>
    </HubShell>
  );
}

function HostedNodeStartingSurface({ node }: { readonly node: HostedHubNode }) {
  const { returnToAllNodes } = useHostedConnectionActions();
  return (
    <HubShell measure="content">
      <HubStatus
        icon={<ServerIcon aria-hidden className="size-8 text-primary" />}
        title={`Connecting to ${node.label}`}
      >
        <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
          <InlineProgress />
          Preparing a private relay session and synchronizing Ryco state…
        </p>
        {/* Until this existed the only way out of "Connecting to X" was to wait
            or reload. It uses the same history-back-equivalent teardown the
            connection controls already use. */}
        <Button
          variant="outline"
          className="mt-5 phone:min-h-11"
          onClick={() => void returnToAllNodes()}
        >
          Back to nodes
        </Button>
      </HubStatus>
    </HubShell>
  );
}

/**
 * What a person who has never seen this Hub needs, kept behind one 32px row so
 * the returning user — who is nearly everyone, nearly every time — pays a line
 * of text for it rather than a screen of it.
 */
function NewToThisHubDisclosure({
  bootstrapAvailable,
  publicSignupEnabled,
}: {
  readonly bootstrapAvailable: boolean;
  readonly publicSignupEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="mt-4">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        // `whitespace-nowrap` is baked into every button variant, and a
        // one-line label whose font has doubled is a label wider than a 320px
        // phone. It wraps instead, and the box grows with it rather than
        // clipping the second line against `h-8`.
        className="-mx-2 h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left phone:min-h-11"
        onClick={() => setOpen((current) => !current)}
      >
        New to this Hub?
        <ChevronDownIcon
          aria-hidden
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </Button>
      {open ? (
        <div id={panelId} className="mt-2 space-y-2 text-xs leading-relaxed text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Getting access.</span> Accounts are
            {publicSignupEnabled
              ? " open to signup on this Hub. Verify your email, then choose a passkey or password."
              : " created by invitation. An owner sends you an invitation code; redeem it below to create your account."}
          </p>
          <p>
            <span className="font-medium text-foreground">What a passkey is here.</span> The passkey
            is created by your browser or password manager and never leaves it. It is the only
            credential this Hub treats as strong.
          </p>
          {bootstrapAvailable ? (
            <p>
              <span className="font-medium text-foreground">If this Hub is brand new.</span> No
              owner exists yet. “Set up first owner” claims this Hub with a bootstrap credential
              from whoever deployed it.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function HostedAuthenticationSurface({
  context = "hub",
}: {
  readonly context?: "hub" | "native-authorization";
} = {}) {
  const status = useHostedHubStore((state) => state.accountStatus);
  const error = useHostedHubStore((state) => state.errorMessage);
  const bootstrapAvailable = useHostedHubStore((state) => state.bootstrapAvailable);
  const [identityLink, setIdentityLink] = useState<HostedIdentityLink | null>(() =>
    consumeHostedIdentityLink({
      href: window.location.href,
      historyState: window.history.state,
      replaceState: (state, unused, url) => window.history.replaceState(state, unused, url),
    }),
  );
  const clearIdentityLink = useCallback(() => setIdentityLink(null), []);
  const { config: publicSignupConfig } = usePublicSignupConfiguration();
  const externalIdentityConfiguration = useHostedAccountStore(
    (state) => state.externalIdentityConfiguration,
  );
  const githubIdentityPolicy = githubProviderPolicy(externalIdentityConfiguration);
  const [externalAuthorizationPending, setExternalAuthorizationPending] = useState(false);
  const [externalAuthorizationError, setExternalAuthorizationError] = useState<string | null>(null);
  const [externalPending, setExternalPending] = useState<
    ExternalIdentityPendingResponse | undefined
  >(undefined);
  // Which ceremony is on screen comes from the URL, not from local state.
  //
  // These were two `useState` discriminators, so every signed-out screen lived
  // at `/` with no address: a refresh dropped you back to sign-in, Back left the
  // Hub instead of stepping out of the flow, and nothing could be linked. The
  // mailed-link arrivals are the same routes — `/public-signup/verify` and
  // `/password-reset` are the Hub server's own mail pathnames — so a reload of
  // one now lands on the page that ceremony belongs to rather than reporting an
  // expired link.
  const hubRoute = useHubRoute();
  const registrationMode =
    hubRoute?.kind === "sign-up" || hubRoute?.kind === "sign-up-verify"
      ? "public"
      : hubRoute?.kind === "invitation"
        ? "invitation"
        : hubRoute?.kind === "setup"
          ? "bootstrap"
          : null;
  const fallbackMode =
    hubRoute?.kind === "sign-in-password"
      ? "password"
      : hubRoute?.kind === "sign-in-recovery-code"
        ? "recovery-code"
        : hubRoute?.kind === "reset-password"
          ? "password-reset"
          : null;
  const setRegistrationMode = (mode: "public" | "invitation" | "bootstrap" | null) => {
    navigateHub(
      mode === "public"
        ? { kind: "sign-up" }
        : mode === "invitation"
          ? { kind: "invitation" }
          : mode === "bootstrap"
            ? { kind: "setup" }
            : { kind: "sign-in" },
    );
  };
  const setFallbackMode = (mode: "password" | "recovery-code" | "password-reset" | null) => {
    navigateHub(
      mode === "password"
        ? { kind: "sign-in-password" }
        : mode === "recovery-code"
          ? { kind: "sign-in-recovery-code" }
          : mode === "password-reset"
            ? { kind: "reset-password" }
            : { kind: "sign-in" },
    );
  };
  const headingRef = useRef<HTMLHeadingElement>(null);
  const registrationInputRef = useRef<HTMLInputElement>(null);
  const surfaceScrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void hostedHubController.refreshExternalIdentityConfiguration();
  }, []);

  useEffect(() => {
    if (registrationMode !== "public" && context !== "native-authorization") {
      setExternalPending(undefined);
      return;
    }
    const operation = new AbortController();
    setExternalPending(undefined);
    void hostedHubApi
      .getPendingExternalIdentity(operation.signal)
      .then((pending) => {
        if (!operation.signal.aborted) setExternalPending(pending);
      })
      .catch(() => {
        if (!operation.signal.aborted) setExternalPending({ status: "none" });
      });
    return () => operation.abort();
  }, [context, registrationMode]);

  const startGitHubSignIn = async () => {
    if (externalAuthorizationPending) return;
    setExternalAuthorizationPending(true);
    setExternalAuthorizationError(null);
    try {
      await beginGitHubAuthorization({
        intent: "authenticate",
        returnTo:
          context === "native-authorization"
            ? window.location.pathname
            : hubRoutePathname({ kind: "sign-up" }),
        start: (request) => hostedHubApi.startExternalIdentityAuthorization(request),
        navigate: (authorizationUrl) => window.location.assign(authorizationUrl),
      });
    } catch (cause) {
      setExternalAuthorizationError(
        cause instanceof HostedHubApiError
          ? cause.message
          : "GitHub sign-in is temporarily unavailable.",
      );
      setExternalAuthorizationPending(false);
    }
  };

  useEffect(() => {
    // `preventScroll`: both targets sit at the top of a surface that owns its
    // own scroller, and a focus-driven scroll would move the anchored action
    // group's content out from under the user before they have touched it.
    if (registrationMode === "invitation" || registrationMode === "bootstrap") {
      registrationInputRef.current?.focus({ preventScroll: true });
    } else {
      // Every ceremony is now its own page with its own heading, so a mode
      // change lands on that page's title rather than leaving focus wherever
      // the previous page left it. Previously the fallback modes were appended
      // to the landing page and had no heading of their own to move to.
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [fallbackMode, registrationMode]);

  useEffect(() => {
    surfaceScrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [fallbackMode, registrationMode]);

  // The action group keeps the exact DOM order and desktop styling it had —
  // the primary stack, then the Hub retry, then the polite announcement — so
  // the desktop card is unchanged. Only the outer wrapper is phone-gated.
  //
  // The stack itself is the only part gated on registration mode: while the
  // registration form is open it owns the primary action. The Hub retry and
  // the polite announcement are NOT part of this group — see `signInTrailing`.
  // The registration action group lives here rather than inside the `<form>`,
  // and reaches its submit through the `form` attribute.
  //
  // This is not tidying. `position: sticky` can never lift a box above the top
  // of its containing block, so while the group was the form's last child the
  // anchoring silently stopped working as soon as the copy above the form grew
  // enough to push the form's top below the pinned position — measured at
  // 320x568, the group clamped to the form's top edge and its primary action
  // landed 2.5px under the fold. As a sibling of the form its containing block
  // is the surface's own content column, exactly like the sign-in group's.
  const registrationActions =
    registrationMode === "invitation" || registrationMode === "bootstrap" ? (
      <div
        className={`mt-6 flex flex-wrap gap-2 phone:mt-auto ${PHONE_ANCHORED_ACTIONS_CLASS_NAME}`}
      >
        <Button
          type="submit"
          form={REGISTRATION_FORM_ID}
          className="phone:min-h-11"
          disabled={status === "authenticating"}
        >
          {registrationMode === "invitation"
            ? "Create account and passkey"
            : "Create owner and passkey"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="phone:min-h-11"
          onClick={
            status === "authenticating"
              ? () => hostedHubController.cancelAuthentication()
              : () => setRegistrationMode(null)
          }
        >
          {status === "authenticating" ? "Cancel" : "Back"}
        </Button>
      </div>
    ) : null;

  const signInActions =
    registrationMode || fallbackMode ? null : (
      <div className={`phone:mt-auto ${PHONE_ANCHORED_ACTIONS_CLASS_NAME}`}>
        <div className="mt-6 flex flex-col gap-3">
          {githubIdentityPolicy?.login ? (
            <Button
              size="lg"
              className="phone:min-h-11"
              disabled={
                externalAuthorizationPending ||
                status === "authenticating" ||
                status === "signing-out"
              }
              onClick={() => void startGitHubSignIn()}
            >
              {externalAuthorizationPending ? (
                <Loader2Icon aria-hidden className="animate-spin" />
              ) : (
                <GitHubIcon aria-hidden />
              )}
              {externalAuthorizationPending ? "Opening GitHub…" : "Continue with GitHub"}
            </Button>
          ) : null}
          <Button
            size="lg"
            className="phone:min-h-11"
            disabled={status === "authenticating" || status === "signing-out"}
            onClick={() => void hostedHubController.signIn()}
          >
            <KeyRoundIcon aria-hidden />
            {status === "authenticating" ? "Waiting for passkey…" : "Sign in with passkey"}
          </Button>
          {status === "authenticating" ? (
            <Button
              variant="outline"
              size="lg"
              className="phone:min-h-11"
              onClick={() => hostedHubController.cancelAuthentication()}
            >
              Cancel
            </Button>
          ) : (
            <>
              {/* The cold visitor's real path, so it stays an outline rather than
                sinking to ghost. */}
              {publicSignupConfig?.status === "enabled" ? (
                <Button
                  variant="outline"
                  size="lg"
                  className="phone:min-h-11"
                  onClick={() => setRegistrationMode("public")}
                >
                  Create account
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="lg"
                className="phone:min-h-11"
                onClick={() => setRegistrationMode("invitation")}
              >
                Redeem invitation
              </Button>
              {bootstrapAvailable ? (
                // Once per Hub, ever. Reducing its weight does not change its
                // height, so the anchoring geometry is untouched.
                <Button
                  variant="ghost"
                  size="lg"
                  className="phone:min-h-11"
                  onClick={() => setRegistrationMode("bootstrap")}
                >
                  Set up first owner
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    );

  // Both of these must mount in EVERY account state, including while the
  // registration form is open. Redeeming an invitation and bootstrapping the
  // first owner both drive `accountStatus` to `authenticating` exactly as
  // sign-in does, and the WebAuthn ceremony then runs for seconds: without a
  // mounted polite region a screen-reader user is told nothing at all, and the
  // form's `role="alert"` only speaks on failure. `Retry Hub` is the recovery
  // path out of an unavailable Hub and must not disappear either. They live in
  // `trailing` rather than inside the action group so no future conditional on
  // the group can take them out of the DOM again.
  const signInTrailing = (
    <>
      {status === "unavailable" ? (
        <Button
          className="mt-3 phone:min-h-11"
          variant="ghost"
          onClick={() => void hostedHubController.bootstrap()}
        >
          <RefreshCwIcon aria-hidden /> Retry Hub
        </Button>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {status === "authenticating" ? "Passkey authentication is in progress." : ""}
      </p>
    </>
  );

  // Mounted on every page of the gateway, not only the landing one. An
  // authentication error is a property of the account state, and each ceremony
  // below can produce one.
  const visibleAuthenticationError = externalAuthorizationError ?? error;
  const authError = visibleAuthenticationError ? (
    <div className="mt-4">
      <Alert variant="error">
        <TriangleAlertIcon aria-hidden />
        <AlertTitle>Sign-in did not complete</AlertTitle>
        <AlertDescription>{visibleAuthenticationError}</AlertDescription>
      </Alert>
    </div>
  ) : null;

  // One page per ceremony.
  //
  // These used to be modes appended *below* the landing page's content inside a
  // single card, so opening password sign-in left "Connect to your Ryco nodes",
  // the relay-trust notice, the "New to this Hub?" disclosure and the PWA
  // install buttons stacked above the fields — a form under someone else's
  // headline. Each ceremony now owns the column and states its own purpose.
  //
  // `signInTrailing` rides every page for the reason its own comment gives: the
  // polite live region must be mounted while a WebAuthn ceremony runs, and
  // invitation and bootstrap drive `accountStatus` to `authenticating` exactly
  // as sign-in does.
  const externalSignup = externalPending?.status === "signup" ? externalPending : null;
  const externalFailure = externalPending?.status === "error" ? externalPending : null;
  const nativeExternalSignup = context === "native-authorization" && registrationMode !== "public";
  if (
    registrationMode === "public" ||
    (nativeExternalSignup && (externalSignup !== null || externalFailure !== null))
  ) {
    const cancelExternalFlow = () => {
      if (nativeExternalSignup) setExternalPending({ status: "none" });
      else setRegistrationMode(null);
    };
    return (
      <HubGateway
        title="Create your account"
        description={
          nativeExternalSignup
            ? "Choose your Ryco username, then return to approving this device."
            : "Pick a username and confirm your email. You choose a passkey or a password at the end."
        }
        trailing={signInTrailing}
        scrollRef={surfaceScrollRef}
        titleRef={headingRef}
      >
        {authError}
        {externalPending === undefined ? (
          <Skeleton className="h-64 w-full rounded-2xl" />
        ) : externalSignup ? (
          <ExternalIdentitySignupFlow
            pendingSignup={externalSignup}
            config={publicSignupConfig?.status === "enabled" ? publicSignupConfig : null}
            onCancel={cancelExternalFlow}
          />
        ) : externalFailure ? (
          <div className="space-y-4">
            <Alert variant="warning">
              <TriangleAlertIcon aria-hidden />
              <AlertTitle>GitHub signup did not continue</AlertTitle>
              <AlertDescription>
                {externalIdentityPendingErrorMessage(externalFailure.code)}
              </AlertDescription>
            </Alert>
            <Button variant="outline" onClick={cancelExternalFlow}>
              Back to sign in
            </Button>
          </div>
        ) : (
          <PublicSignupFlow
            config={publicSignupConfig?.status === "enabled" ? publicSignupConfig : null}
            initialLink={identityLink}
            onConsumeLink={clearIdentityLink}
            onCancel={() => {
              clearIdentityLink();
              setRegistrationMode(null);
            }}
          />
        )}
      </HubGateway>
    );
  }

  if (registrationMode === "invitation" || registrationMode === "bootstrap") {
    return (
      <HubGateway
        title={registrationMode === "invitation" ? "Redeem your invitation" : "Claim this Hub"}
        description={
          registrationMode === "invitation"
            ? "Enter the invitation code an owner sent you. Your browser creates a passkey at the same time."
            : "No owner exists yet. The bootstrap credential from whoever deployed this Hub makes you its first owner."
        }
        actions={registrationActions}
        trailing={signInTrailing}
        scrollRef={surfaceScrollRef}
        titleRef={headingRef}
      >
        {authError}
        <RegistrationForm mode={registrationMode} credentialRef={registrationInputRef} />
      </HubGateway>
    );
  }

  if (fallbackMode !== null) {
    const fallbackPage = {
      password: {
        title: "Sign in with a password",
        description:
          "Password sign-in always asks for a second factor — an authenticator code, or a code sent to your verified email.",
      },
      "recovery-code": {
        title: "Use a recovery code",
        description:
          "One of the single-use codes you saved when your account was created. Each code works once.",
      },
      "password-reset": {
        title: "Reset your password",
        description:
          "We email a single-use link. Setting a new password signs out every device, including this one.",
      },
    }[fallbackMode];

    return (
      <HubGateway
        title={fallbackPage.title}
        description={fallbackPage.description}
        trailing={signInTrailing}
        scrollRef={surfaceScrollRef}
        titleRef={headingRef}
      >
        {authError}
        {fallbackMode === "password" ? (
          <PasswordLoginFlow
            onCancel={() => setFallbackMode(null)}
            onUseRecoveryCode={() => setFallbackMode("recovery-code")}
            onResetPassword={() => setFallbackMode("password-reset")}
          />
        ) : fallbackMode === "recovery-code" ? (
          <RecoveryCodeFlow onCancel={() => setFallbackMode(null)} />
        ) : (
          <PasswordResetFlow
            initialLink={identityLink}
            onConsumeLink={clearIdentityLink}
            onCancel={() => {
              clearIdentityLink();
              setFallbackMode(null);
            }}
          />
        )}
      </HubGateway>
    );
  }

  return (
    <HubGateway
      title={
        context === "native-authorization"
          ? "Sign in to continue on your device"
          : status === "session-expired"
            ? "Your session expired"
            : "Connect to your Ryco nodes"
      }
      description={
        context === "native-authorization"
          ? "Authenticate in this browser first. Ryco will ask again before it authorizes the mobile app."
          : "Ryco Hub reaches the developer machines an owner has authorized for your account. Your session lives in an HttpOnly cookie — nothing about it is readable by this page."
      }
      actions={signInActions}
      trailing={signInTrailing}
      scrollRef={surfaceScrollRef}
      titleRef={headingRef}
    >
      <HostedRelayTrustNotice />
      <NewToThisHubDisclosure
        bootstrapAvailable={bootstrapAvailable}
        publicSignupEnabled={publicSignupConfig?.status === "enabled"}
      />
      {status !== "authenticating" ? (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mt-2 h-auto min-h-8 whitespace-normal phone:min-h-11"
          onClick={() => setFallbackMode("password")}
        >
          <LifeBuoyIcon aria-hidden />
          Password, recovery code, or reset
        </Button>
      ) : null}
      <HostedPwaControls />
      {authError}
    </HubGateway>
  );
}

/** The id the out-of-form submit control points at. */
const REGISTRATION_FORM_ID = "hub-registration-form";

function RegistrationForm({
  mode,
  credentialRef,
}: {
  readonly mode: "invitation" | "bootstrap";
  readonly credentialRef: RefObject<HTMLInputElement | null>;
}) {
  const [credential, setCredential] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [passkeyLabel, setPasskeyLabel] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const registrationCredential = credential;
    setCredential("");
    const registrationInput = {
      displayName: displayName.trim(),
      passkeyLabel: passkeyLabel.trim() || null,
    };
    if (mode === "invitation") {
      await hostedHubController.redeemInvitation({
        secret: registrationCredential,
        ...registrationInput,
      });
    } else {
      await hostedHubController.bootstrapOwner({
        credential: registrationCredential,
        ...registrationInput,
      });
    }
  };

  return (
    <form
      id={REGISTRATION_FORM_ID}
      className="mt-6 space-y-4"
      onSubmit={(event) => void submit(event)}
      autoComplete="off"
    >
      <div className="space-y-1.5">
        <Label htmlFor="hub-registration-credential">
          {mode === "invitation" ? "Invitation code" : "Bootstrap credential"}
        </Label>
        <Input
          ref={credentialRef}
          id="hub-registration-credential"
          type="password"
          required
          maxLength={128}
          value={credential}
          className={TOUCH_INPUT_CLASS_NAME}
          onChange={(event) => setCredential(event.currentTarget.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="hub-display-name">Display name</Label>
        <Input
          id="hub-display-name"
          required
          maxLength={200}
          value={displayName}
          className={TOUCH_INPUT_CLASS_NAME}
          onChange={(event) => setDisplayName(event.currentTarget.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="hub-passkey-label">
          Passkey label <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="hub-passkey-label"
          maxLength={100}
          value={passkeyLabel}
          className={TOUCH_INPUT_CLASS_NAME}
          onChange={(event) => setPasskeyLabel(event.currentTarget.value)}
        />
      </div>
    </form>
  );
}

function RecoveryCodesSurface() {
  const recoveryCodes = useHostedHubStore((state) => state.recoveryCodes);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    // Keeps owning the viewport, unwrapped by any shell: this is a one-shot
    // secret display and nothing may compete with its acknowledgement.
    <HubGateway
      title="Save your recovery codes"
      description={
        // The count comes from the set. The Hub validates 1..256 codes, so copy
        // or a two-column-of-five layout that assumes a number is wrong the day
        // an operator changes it — and "Save your 1 recovery codes" is what
        // putting it in the heading produces.
        `Save all ${String(recoveryCodes.length)} codes — they are shown once and cannot be retrieved later. Ryco does not save them in browser storage.`
      }
      actions={
        <div className={`phone:mt-auto ${PHONE_ANCHORED_ACTIONS_CLASS_NAME}`}>
          {/* Above the acknowledgement, so the acknowledgement stays the
              group's last child and its fold geometry is unchanged. The
              settings twin has had a copy control since it shipped; the same
              secret at the moment the user needs it most had none. */}
          <Button
            variant="outline"
            className="mt-5 w-full phone:min-h-11"
            onClick={() =>
              copyToClipboard(formatRecoveryCodesForClipboard(recoveryCodes), undefined)
            }
          >
            {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {isCopied ? "Copied" : "Copy codes"}
          </Button>
          <Button
            size="cta"
            className="mt-3 w-full"
            onClick={() => hostedHubController.dismissRecoveryCodes()}
          >
            I saved the codes
          </Button>
        </div>
      }
    >
      <ul
        aria-label="Recovery codes"
        className="grid gap-2 rounded-xl border border-border bg-background p-4 font-mono text-sm break-all sm:grid-cols-2"
      >
        {recoveryCodes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
    </HubGateway>
  );
}

function NodeRow({
  node,
  nowMs,
  disabled,
  onConnect,
  onOpenDetail,
}: {
  readonly node: HostedHubNode;
  /**
   * One ticking snapshot for the whole list rather than a timer per row: at
   * twenty nodes the per-row hook was twenty intervals for a label that only
   * changes once a minute.
   */
  readonly nowMs: number;
  readonly disabled: boolean;
  readonly onConnect: () => void;
  readonly onOpenDetail: () => void;
}) {
  const lastSeen = lastSeenLabel(node, nowMs);

  return (
    // Two sibling controls with a full-height divider — never a button inside a
    // button, never an `absolute inset-0` overlay.
    //
    // `overflow-hidden` is what keeps the divider and the hover fill inside the
    // radius, and it is also a clip on both children: an OUTSET ring is drawn
    // outside the border box, so on a control that fills its parent's padding
    // box three of its four sides land in the clipped region. Every focus
    // indicator inside this row is therefore inset — the same rule the phone
    // home's identical two-control rows follow.
    <li className="flex items-stretch overflow-hidden rounded-xl border border-border bg-background">
      <button
        type="button"
        disabled={disabled}
        onClick={onConnect}
        className="flex min-h-16 min-w-0 flex-1 flex-wrap items-center gap-3 px-4 py-3 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-60 disabled:hover:bg-transparent phone:min-h-18"
      >
        {/* `ServerIcon` for every platform: lucide has no legitimate macOS or
            Windows mark, and shipping a vendor glyph would be brand
            fabrication as well as colour-adjacent information. */}
        <span className="flex size-[36px] shrink-0 items-center justify-center rounded-lg bg-muted">
          <ServerIcon aria-hidden className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{node.label}</span>
          <span className="block truncate text-xs text-muted-foreground">{nodeMetaLine(node)}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          {/* Revocation is stated exactly once, here, by the unmodified
              presence component; the reason is folded into the meta line. */}
          <NodePresence node={node} />
          {lastSeen ? (
            <span className="whitespace-nowrap text-[11px] text-muted-foreground max-sm:hidden phone:hidden">
              {lastSeen}
            </span>
          ) : null}
        </span>
      </button>
      <span aria-hidden className="w-px shrink-0 bg-border/60" />
      {/* Never disabled — not for a revoked node, not while the directory is
          stale. Being unable to connect is exactly when the metadata is needed;
          disabling this would hide the explanation behind the symptom.

          Node identity is in the NAME, not in an `aria-describedby`
          description. A description is supplementary and is not what a
          name-based interface addresses: with every row named "Node details",
          "click Node details" was ambiguous on every directory with more than
          one node, and voice control had no way to say which. The action leads
          so a reader still hears what the control does first, and putting the
          label after a prefix — rather than "Studio details" — keeps the row's
          connect control the only accessible name that *starts* with the node's
          own label. */}
      <button
        type="button"
        aria-label={`Node details: ${node.label}`}
        onClick={onOpenDetail}
        className="flex w-[44px] shrink-0 items-center justify-center text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ChevronRightIcon aria-hidden className="size-4" />
      </button>
    </li>
  );
}

function HostedNodeDirectory() {
  const nodes = useHostedHubStore((state) => state.nodes);
  const status = useHostedHubStore((state) => state.directoryStatus);
  const browserStatus = useHostedHubStore((state) => state.browserStatus);
  const error = useHostedHubStore((state) => state.errorMessage);
  const account = useHostedHubStore((state) => state.account);
  const selection = useHostedHubStore((state) => state.selectionStatus);
  const routeNotice = useHostedNodeRouteNotice();
  const navigate = useNavigate();
  const isPhoneTier = usePresentationTier() === "phone";
  // Enrollment is a page, not a flag: `/nodes/enroll` survives a refresh and
  // Back steps out of the wizard instead of leaving the Hub.
  const enrolling = useHubRoute()?.kind === "nodes-enroll";
  const setEnrolling = (next: boolean) =>
    navigateHub(next ? { kind: "nodes-enroll" } : { kind: "nodes" });
  // The *id*, never the node object. `listNodes` polls every 20 seconds and
  // replaces every row, so a captured `HostedHubNode` is a snapshot of the
  // moment the sheet was opened and stops tracking the machine it describes: a
  // revocation that lands while the sheet is up would leave `Connect` enabled
  // against a `revokedAt` the poll had already set, and the sheet would keep
  // printing an "Online" status, a superseded client version, and a heartbeat
  // age that grows for a node that is heartbeating the whole time.
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);
  // Set when `revokeNode` RESOLVES, not when a row stops being rendered.
  //
  // A revocation is the one action here that cannot be taken back, and the only
  // evidence it happened used to be the row disappearing — which is evidence the
  // client is not entitled to. The re-read that removes the row settles its own
  // failures into `directoryStatus` and leaves `nodes` exactly as it found them,
  // so a Hub restart or a blip in the second after the commit leaves an
  // unchanged list, a closed dialog, and nothing said: indistinguishable from
  // having cancelled.
  const [revokedNotice, setRevokedNotice] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nowMs = useRelativeTimeTick(60_000);

  useEffect(() => {
    // Returning from a node used to land focus at the document root. The
    // heading, not the list: moving initial focus into the rows drops a screen
    // reader user past the surface's own title.
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const select = async (node: HostedHubNode) => {
    // With the hosted node history installed, selection navigates into the
    // node-scoped route and the route orchestrator drives `selectNode`.
    if (selectHostedNodeRoute(node.id)) return;
    await navigate({ to: "/", replace: true });
    await hostedHubController.selectNode(node.id);
  };

  if (enrolling) {
    return (
      <HubShell measure="content">
        <HostedNodeEnrollmentFlow onClose={() => setEnrolling(false)} />
      </HubShell>
    );
  }

  const ordered = sortNodes(nodes);
  // Re-resolved on every render, so the sheet reads the same store the rows
  // under it read. A node that leaves the directory entirely closes the sheet
  // rather than stranding it on a machine this account can no longer see.
  const detailNode =
    detailNodeId === null
      ? null
      : (nodes.find((candidate) => candidate.id === detailNodeId) ?? null);
  const isOwner = account?.role === "owner";
  const showEmptyState = status === "ready" && nodes.length === 0;
  // Exactly one enroll control exists at all times: when the empty state owns
  // it, the anchored group drops it.
  const enrollInActions = isOwner && !showEmptyState;

  const accountButton = (
    <Button
      variant="ghost"
      className="min-h-11 flex-1"
      onClick={() => {
        navigateHub({ kind: "account", section: "security" });
      }}
    >
      <UserRoundIcon aria-hidden /> Account
    </Button>
  );
  const signOutButton = (
    <Button
      variant="ghost"
      className="min-h-11 flex-1"
      onClick={() => void hostedHubController.signOut()}
    >
      <LogOutIcon aria-hidden /> Sign out
    </Button>
  );
  // `phone:w-full` is what makes the anchored group three stacked rows rather
  // than inline-flex buttons flowing onto one line at 390px.
  const enrollButton = (
    <Button
      className={isPhoneTier ? "mt-3 phone:min-h-11 phone:w-full" : undefined}
      onClick={() => setEnrolling(true)}
    >
      <ServerIcon aria-hidden /> Enroll node
    </Button>
  );
  const refreshButton = (
    <Button
      className={isPhoneTier ? "mt-3 phone:min-h-11 phone:w-full" : undefined}
      variant="outline"
      disabled={status === "loading"}
      onClick={() => void hostedHubController.refreshDirectory()}
    >
      {status === "loading" ? (
        // Not `ui/spinner.tsx`: its hardcoded `role="status"` would add a live
        // region to a surface whose stale/loading announcements are already
        // deliberate and singular. The label is retained either way.
        <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" />
      ) : (
        <RefreshCwIcon aria-hidden />
      )}
      Refresh nodes
    </Button>
  );

  return (
    <HubShell
      trailing={
        // The account and sign-out controls belong to the Hub, not to the node
        // list, so on desktop they move out of the page and into the Hub bar.
        // On the phone tier they stay in the anchored action group below — see
        // the note there.
        <>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Account settings"
            onClick={() => {
              navigateHub({ kind: "account", section: "security" });
            }}
          >
            <UserRoundIcon aria-hidden />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Sign out"
            onClick={() => void hostedHubController.signOut()}
          >
            <LogOutIcon aria-hidden />
          </Button>
        </>
      }
    >
      <HubPage
        titleRef={headingRef}
        title={nodes.length === 1 ? "Your node" : "Your nodes"}
        description={
          <>
            <p className="truncate">
              Signed in as {account?.displayName ?? "Hub account"}
              {account ? ` · ${account.role.charAt(0).toUpperCase()}${account.role.slice(1)}` : ""}
            </p>
            {nodes.length > 1 ? (
              <p className="mt-0.5 truncate text-xs">{directoryCountLine(nodes)}</p>
            ) : null}
          </>
        }
        actions={
          // Page-level actions sit with the page title on desktop. On the phone
          // tier the page header carries none and they stay in the anchored
          // group, which is what the fold assertions measure.
          isPhoneTier ? undefined : (
            <>
              {refreshButton}
              {enrollInActions ? enrollButton : null}
            </>
          )
        }
      >
        {/* Advisory, and it explains why the rows are disabled — so `status`,
          not the `Alert` default `alert`, which would interrupt. */}
        {status === "stale" ? (
          <div className="mt-4">
            <Alert variant="warning" role="status">
              <TriangleAlertIcon aria-hidden />
              <AlertDescription>
                {/* Names the action it actually describes. `nodeSelectionBlocked`
                  gates CONNECTING and nothing else — details, Rename and Revoke
                  are all live in this state, deliberately: a directory whose
                  poll is failing is not the same thing as a Hub that cannot take
                  an owner's revocation, and gating the one irreversible control
                  on a stale read would disable it during exactly the incident it
                  exists for. What could not stand was the banner saying
                  otherwise directly above it. */}
                Directory data is stale. Connecting is unavailable until it refreshes.
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        {revokedNotice ? (
          <div className="mt-4">
            {/* `status`, not `alert`: the revocation succeeded, and an assertive
              live region would interrupt a screen reader mid-sentence to say so.
              It is not auto-dismissed — the next poll may not remove the row, and
              a receipt that outlives the thing it is evidence for is the point. */}
            <Alert variant="warning" role="status">
              <TriangleAlertIcon aria-hidden />
              <AlertDescription>{revokedNotice}</AlertDescription>
            </Alert>
          </div>
        ) : null}
        {/* One error region, first match wins. Three simultaneous red paragraphs
          above a list of disabled rows read as breakage, and only the first is
          ever actionable. The `status !== "stale"` suppression on the store's
          own message is preserved exactly. */}
        <DirectoryError
          selection={selection}
          routeNotice={routeNotice}
          error={status === "stale" ? null : error}
        />
        {showEmptyState ? (
          <DirectoryEmptyState isOwner={isOwner} onEnroll={() => setEnrolling(true)} />
        ) : (
          <>
            <ul role="list" className="mt-5 space-y-2" aria-busy={status === "loading"}>
              {ordered.map((node) => (
                <NodeRow
                  key={`${node.id}:${node.environmentId}`}
                  node={node}
                  nowMs={nowMs}
                  disabled={nodeSelectionBlocked({ directoryStatus: status, browserStatus, node })}
                  onConnect={() => void select(node)}
                  onOpenDetail={() => setDetailNodeId(node.id)}
                />
              ))}
              {status === "loading" && nodes.length === 0 ? (
                <>
                  {/* Skeletons only when there is nothing to keep: a refresh over
                    a live list keeps the rows and reports itself on the control
                    that was pressed. Skeletons carry no operable element. */}
                  {[0, 1, 2].map((index) => (
                    <li key={index}>
                      <Skeleton className="h-16 w-full rounded-xl" />
                    </li>
                  ))}
                </>
              ) : null}
            </ul>
            {status === "loading" && nodes.length === 0 ? (
              <p role="status" aria-live="polite" className="sr-only">
                Loading authorized nodes…
              </p>
            ) : null}
            {nodes.length > 0 ? (
              // The honest counterweight to a green pill that can be 20 seconds
              // stale — longer while the tab is backgrounded.
              <p className="mt-2 px-1 text-[11px] text-muted-foreground">
                Presence refreshes about every 20 seconds.
              </p>
            ) : null}
          </>
        )}
        <div className="mt-5">
          <HostedRelayTrustNotice />
        </div>
        <HostedPwaControls />
        <HostedNodeDetail
          node={detailNode}
          directoryStatus={status}
          browserStatus={browserStatus}
          canRename={isOwner}
          canRevoke={isOwner}
          onOpenChange={(open) => {
            if (!open) setDetailNodeId(null);
          }}
          onConnect={(node) => void select(node)}
          onRename={async (node, label) => {
            await hostedHubApi.renameNode(node.id, label);
            await hostedHubController.refreshDirectory();
          }}
          onRevoke={async (node) => {
            // The Hub answers first, and only then is the list re-read. Nothing
            // here removes the row ahead of that answer: an optimistic removal
            // that has to be undone is a worse report of a refused revocation than
            // a control that stayed busy, and this is the one action in the
            // directory that cannot be taken back if it did land.
            //
            // The row goes away because the node stops being in the directory at
            // all — `authorizedDirectoryEntry` resolves to nothing once `revokedAt`
            // is set — so this needs no removal of its own. `refreshDirectory`
            // settles its own failures into `directoryStatus`, so only the
            // mutation above can reject here, and only its failure reaches the
            // confirmation.
            //
            // WHICH IS ALSO WHY THE ROW IS NOT THE RECEIPT. That same swallowed
            // failure leaves `nodes` untouched, so the re-read below is allowed to
            // return a list that still has this node on it. The acknowledgement is
            // therefore taken from `revokeNode` resolving — the one fact the
            // client actually has — and is set before the re-read is even
            // attempted.
            await hostedHubApi.revokeNode(node.id, HOSTED_NODE_REVOKE_REASON_CODE);
            setRevokedNotice(hostedNodeRevokedNotice(node.label));
            await hostedHubController.refreshDirectory();
            // Load-bearing exactly when the refresh above failed or came back
            // stale: `detailNode` is re-resolved from `nodes` every render, so on
            // the happy path the sheet closes itself. On the unhappy one this is
            // the only thing standing between the owner and a live Revoke button
            // on a machine that has just been revoked.
            setDetailNodeId(null);
          }}
        />
      </HubPage>
      {isPhoneTier ? (
        // The phone tier's action group, unchanged in composition and order:
        // three rows at most, primary last. That is what makes the fold
        // assertion hold by construction rather than by a 15-pixel margin, and
        // it puts the most-used control nearest the thumb. The group carries no
        // margin of its own — all spacing lives on the children.
        <div className={`mt-auto ${PHONE_ANCHORED_ACTIONS_CLASS_NAME}`}>
          <div className="mt-5 flex flex-wrap gap-2">
            {accountButton}
            {signOutButton}
          </div>
          {enrollInActions ? enrollButton : null}
          {refreshButton}
        </div>
      ) : null}
    </HubShell>
  );
}

function DirectoryError({
  selection,
  routeNotice,
  error,
}: {
  readonly selection: string;
  readonly routeNotice: string | null;
  readonly error: string | null;
}) {
  const selectionMessage =
    selection === "authorization-removed"
      ? "Authorization for the previous node was removed."
      : selection === "revoked"
        ? "The previous node or grant was revoked."
        : selection === "incompatible"
          ? "The previous node uses an incompatible relay version."
          : null;
  const message = selectionMessage ?? routeNotice ?? error;
  if (!message) return null;
  return (
    <div className="mt-4">
      <Alert variant="error">
        <TriangleAlertIcon aria-hidden />
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </div>
  );
}

function DirectoryEmptyState({
  isOwner,
  onEnroll,
}: {
  readonly isOwner: boolean;
  readonly onEnroll: () => void;
}) {
  return (
    <Empty className="min-h-64">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {isOwner ? <ServerIcon aria-hidden /> : <ShieldCheckIcon aria-hidden />}
        </EmptyMedia>
        <EmptyTitle>No nodes yet</EmptyTitle>
        <EmptyDescription>
          {isOwner
            ? "A node appears here once the Ryco client on that machine has been enrolled. Start enrollment on the node, then enter the short device code it shows — codes expire after ten minutes."
            : "A node appears here once an owner of this Hub authorizes your account for it."}
        </EmptyDescription>
      </EmptyHeader>
      {/* No disabled Enroll button for a non-owner: a greyed control implies
          the capability is coming. */}
      {isOwner ? (
        <EmptyContent>
          <Button className="phone:min-h-11" onClick={onEnroll}>
            <ServerIcon aria-hidden /> Enroll node
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
