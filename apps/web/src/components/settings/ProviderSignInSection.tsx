import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ProviderSignInState,
  type ServerProvider,
  WS_METHODS,
} from "@ryco/contracts";
import { isUnknownUnionMember } from "@ryco/contracts/base-schemas";
import {
  describeProviderSignIn,
  formatProviderSignInCountdown,
  getProviderSignInController,
  isProviderSignInPageUrl,
  isProviderSignInRunning,
  isProviderSignInTerminalWaiting,
  PROVIDER_SIGN_IN_FORBIDDEN,
  providerSignInOutcome,
  type ProviderSignInApi,
  type ProviderSignInController,
} from "@ryco/client-runtime/state/providerSignIn";
import { providerNeedsSignIn } from "@ryco/shared/providerSignIn";
import { CheckIcon, CopyIcon, ExternalLinkIcon, LoaderIcon, LogInIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../../environments/runtime";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { hostedCapabilityCopy } from "../../hostedHub/switchTarget";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import {
  preloadableLazy,
  useLazyComponentReady,
  usePreloadWhenIdle,
} from "../../lib/preloadableLazy";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { notifySurfaceLoadFailure } from "../ui/surfaceLoadFailure";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { RedactedEmail } from "./RedactedSensitiveText";
import { useRelativeTimeTick } from "./settingsLayout";

export interface ProviderSignInSectionProps {
  /** The node the instance runs on; `null` is this app's primary node. */
  readonly environmentId: EnvironmentId | null;
  readonly nodeLabel: string;
  /** Whether the app holds a connection to the node now. */
  readonly connected: boolean;
  /** Whether this session may change the node's providers (a settings target's role). */
  readonly canManage?: boolean;
  readonly instanceId: ProviderInstanceId;
  /** The instance's own enabled flag, which a toggle changes before the node re-probes. */
  readonly instanceEnabled: boolean;
  readonly displayName: string;
  readonly provider: ServerProvider | undefined;
  /**
   * `inline` drops the card's rule and padding and names the instance in its heading, for a
   * surface that frames the section itself.
   */
  readonly variant?: "card" | "inline";
  /** Every state the node reports, e.g. to close a surface once its sign-in succeeded. */
  readonly onStateChange?: (state: ProviderSignInState) => void;
}

const readNoApi = () => null;

// Loads with the first terminal sign-in: xterm stays out of the settings and setup chunks.
const ProviderSignInTerminal = preloadableLazy(() =>
  import("./ProviderSignInTerminal").then((module) => module.ProviderSignInTerminal),
);

/** The sign-in methods of the app's connection to the node, following reconnects. */
function useConnectionSignInApi(environmentId: EnvironmentId | null): ProviderSignInApi | null {
  const read =
    environmentId === null
      ? readNoApi
      : () => readEnvironmentConnection(environmentId)?.client.providerSignIn ?? null;
  return useSyncExternalStore(subscribeEnvironmentConnections, read, read);
}

function Countdown({ expiresAt }: { readonly expiresAt: string | null }) {
  const nowMs = useRelativeTimeTick(1_000);
  const remaining = formatProviderSignInCountdown(expiresAt, nowMs);
  if (remaining === null) return null;
  return (
    <span className="text-muted-foreground">
      Expires in <span className="font-mono tabular-nums">{remaining}</span>
    </span>
  );
}

function DeviceCode({
  verificationUrl,
  userCode,
}: {
  readonly verificationUrl: string;
  readonly userCode: string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy the code",
          description: error.message,
        }),
      );
    },
  });
  const opensHere = isProviderSignInPageUrl(verificationUrl);
  return (
    <div className="space-y-2">
      <p>
        Open{" "}
        <span className="select-all break-all font-mono text-foreground">{verificationUrl}</span>{" "}
        and enter this code:
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code
          aria-label="Sign-in code"
          className="select-all rounded-md border border-border/70 bg-muted/40 px-2 py-1 font-mono text-base tracking-widest text-foreground"
        >
          {userCode}
        </code>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => copyToClipboard(userCode, undefined)}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
          {isCopied ? "Copied" : "Copy"}
        </Button>
        {opensHere ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              void readLocalApi()
                ?.shell.openExternal(verificationUrl)
                .catch(() => {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Could not open the sign-in page",
                      description: "Open the address above in a browser and enter the code.",
                    }),
                  );
                });
            }}
          >
            <ExternalLinkIcon />
            Open sign-in page
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Signs a provider instance in on its node: the node runs the provider's own login, and this
 * shows what to do with it (a device code for Codex). Shown while the instance reports no
 * sign-in, and for as long as the node shows a flow this followed. The flow is the node's, so
 * closing this or the app does not end it.
 */
export function ProviderSignInSection({
  environmentId,
  nodeLabel,
  connected,
  canManage = true,
  instanceId,
  instanceEnabled,
  displayName,
  provider,
  variant = "card",
  onStateChange,
}: ProviderSignInSectionProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const nodeEnvironmentId = environmentId ?? primaryEnvironmentId;
  const capability = useHostedRpcCapability(WS_METHODS.providerSignInStart, environmentId);
  const blockedReason = capability.allowed
    ? null
    : (hostedCapabilityCopy(capability, nodeLabel) ?? PROVIDER_SIGN_IN_FORBIDDEN);
  const api = useConnectionSignInApi(nodeEnvironmentId);
  const controller: ProviderSignInController | null =
    nodeEnvironmentId === null ? null : getProviderSignInController(nodeEnvironmentId, instanceId);

  const needsSignIn = provider !== undefined && providerNeedsSignIn(provider);
  // Followed from the first time the instance needs a sign-in, so a success stays visible.
  const [engaged, setEngaged] = useState(needsSignIn);
  if (needsSignIn && !engaged) setEngaged(true);
  const follows = engaged && capability.allowed && connected && canManage && api !== null;

  useEffect(() => {
    if (!follows || controller === null || api === null) return;
    return controller.attach(api);
  }, [api, controller, follows]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? subscribeToNothing,
    controller?.getSnapshot ?? readNothing,
    controller?.getSnapshot ?? readNothing,
  );
  const state = follows ? (snapshot?.state ?? null) : null;
  const running = isProviderSignInRunning(state);

  // A terminal flow keeps its terminal from the start, and after a failure while it shows why.
  const hasOutput = useSyncExternalStore(
    controller?.onOutput ?? subscribeToNothing,
    controller === null ? readNoOutput : () => controller.output() !== "",
    readNoOutput,
  );
  const terminalFlowId =
    state?.method === "terminal" &&
    state.flowId !== null &&
    (running || (state.phase === "failed" && hasOutput))
      ? state.flowId
      : null;
  const terminalReady = useLazyComponentReady(ProviderSignInTerminal, terminalFlowId !== null, {
    onLoadError: (loadError, retry) =>
      notifySurfaceLoadFailure("sign-in terminal", loadError, retry),
  });
  usePreloadWhenIdle(
    ProviderSignInTerminal,
    state?.phase === "idle" && state.method === "terminal",
  );

  const reported = useRef(onStateChange);
  useLayoutEffect(() => {
    reported.current = onStateChange;
  });
  useEffect(() => {
    if (state !== null) reported.current?.(state);
  }, [state]);

  const shown = needsSignIn || (state !== null && state.phase !== "idle");
  if (!engaged || !shown) return null;

  const {
    pending,
    unavailable,
    followFailed,
    canRetryFollow,
    canStart,
    canCancel,
    startLabel,
    error,
  } = describeProviderSignIn({
    snapshot,
    state,
    nodeLabel,
    blockedReason,
    connected: connected && api !== null,
    canManage,
    instanceEnabled,
  });
  const interaction = state?.phase === "waiting" ? state.interaction : null;

  return (
    <section
      aria-label={`Sign in to ${displayName}`}
      className={cn(
        "phone:hidden space-y-2 text-xs",
        variant === "card" && "border-t border-border/60 px-4 py-3 sm:px-5",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <strong>{variant === "inline" ? `Sign in to ${displayName}` : "Account sign-in"}</strong>
        {running ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!canCancel}
            onClick={() => void controller?.cancel()}
          >
            Cancel
          </Button>
        ) : state?.phase !== "succeeded" ? (
          <Button
            type="button"
            size="xs"
            variant={state?.phase === "idle" ? "default" : "outline"}
            disabled={!canStart && !canRetryFollow}
            onClick={() => {
              if (canRetryFollow) controller?.retryFollowing();
              else void controller?.start();
            }}
          >
            {pending === "start" ? <LoaderIcon className="animate-spin" /> : <LogInIcon />}
            {startLabel}
          </Button>
        ) : null}
      </div>

      {unavailable !== null ? (
        <p className="text-muted-foreground">{unavailable}</p>
      ) : followFailed ? null : state === null ? (
        <p className="text-muted-foreground" role="status">
          Checking sign-in on {nodeLabel}…
        </p>
      ) : state.phase === "idle" ? (
        state.method === null ? (
          <p className="text-muted-foreground">
            {state.unavailableReason ?? "Sign-in from Ryco is not available for this instance."}
          </p>
        ) : (
          <p className="text-muted-foreground">
            {snapshot?.interrupted ? "Sign-in was interrupted. Start again. " : null}
            {state.method === "terminal" ? (
              <>
                Runs {displayName}&rsquo;s login in a terminal on {nodeLabel}. Its links open on
                this device.
              </>
            ) : (
              <>
                Runs {displayName}&rsquo;s sign-in on {nodeLabel}. The page opens on this device.
              </>
            )}
          </p>
        )
      ) : state.phase === "starting" ? (
        <p className="flex items-center gap-1.5 text-muted-foreground" role="status">
          <LoaderIcon className="size-3 animate-spin" />
          Starting the sign-in on {nodeLabel}…
        </p>
      ) : state.phase === "waiting" ? (
        // No live region: the countdown would be announced every second.
        <div className="space-y-2">
          {interaction !== null &&
          !isUnknownUnionMember(interaction) &&
          interaction.type === "deviceCode" ? (
            <DeviceCode
              verificationUrl={interaction.verificationUrl}
              userCode={interaction.userCode}
            />
          ) : isProviderSignInTerminalWaiting(state) ? (
            <p className="text-muted-foreground">
              Answer {displayName}&rsquo;s login in the terminal below. Its links open on this
              device.
            </p>
          ) : (
            <p className="text-muted-foreground">
              This sign-in needs a newer Ryco on this device. Update it to continue, or cancel the
              sign-in.
            </p>
          )}
          <Countdown expiresAt={state.expiresAt} />
        </div>
      ) : state.phase === "verifying" ? (
        <p className="flex items-center gap-1.5 text-muted-foreground" role="status">
          <LoaderIcon className="size-3 animate-spin" />
          Checking the account…
        </p>
      ) : state.phase === "succeeded" ? (
        // Not the node's message: it names the account, which stays blurred until clicked.
        <p role="status">
          {provider?.auth.email ? (
            <>
              Signed in as <RedactedEmail email={provider.auth.email} />
            </>
          ) : provider?.auth.label ? (
            `Signed in as ${provider.auth.label}.`
          ) : (
            "Signed in."
          )}
        </p>
      ) : (
        <p role="status">{providerSignInOutcome(state)}</p>
      )}

      {terminalFlowId !== null && controller !== null ? (
        <div
          key={terminalFlowId}
          role="group"
          aria-label={`${displayName} login terminal`}
          className="h-64 overflow-hidden rounded-md border border-border/70 bg-background p-2"
        >
          {terminalReady ? (
            <ProviderSignInTerminal
              controller={controller}
              interactive={isProviderSignInTerminalWaiting(state)}
            />
          ) : (
            <LoaderIcon className="size-3 animate-spin text-muted-foreground" />
          )}
        </div>
      ) : null}

      {error ? (
        <p className="text-destructive-foreground" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

const subscribeToNothing = () => () => undefined;
const readNothing = () => null;
const readNoOutput = () => false;
