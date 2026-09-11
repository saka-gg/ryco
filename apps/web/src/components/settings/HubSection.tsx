import { TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DesktopHubLaunchConfig,
  DesktopHostedIdentityState,
  HubConnectorStatus,
  HubEnrollmentCeremonyDetail,
  HubIdentitySummary,
} from "@ryco/contracts";
import { EnvironmentId } from "@ryco/contracts";
import relayArchitectureGuideUrl from "../../../../../docs/relay-architecture.html?url";
import {
  createVisibilityAwarePoller,
  type VisibilityAwarePoller,
} from "../../lib/visibilityPolling";
import { webAppLifecycle } from "../../platform/appLifecycle";
import {
  retainDesktopWorkspaceInteractiveScope,
  retainDesktopWorkspaceProviderScope,
  useDesktopWorkspaceState,
} from "../../platform/desktopWorkspace";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { useStore } from "../../store";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  cancelHubEnrollment,
  fetchHubEnrollment,
  fetchHubIdentity,
  fetchHubStatus,
  leaveHub,
  resumeHubConnector,
  startHubEnrollment,
} from "~/environments/primary";
import { AnimatedHeight } from "../AnimatedHeight";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { DataList, DataListItem } from "../ui/data-list";
import { Input } from "../ui/input";
import { HubAdvancedOptions } from "./HubAdvancedOptions";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import { canEditHubOrigin, presentHubStatus, type HubAction } from "./hubStatus";

/**
 * Matches the diagnostics panel's cadence.
 *
 * One interval for every state. Polling faster while awaiting approval cannot
 * surface an approval sooner because the server's own enrollment poll runs at the
 * Hub-dictated interval, and this only reads the resulting local snapshot.
 */
const HUB_STATUS_POLL_MS = 5_000;

/** How long a snapshot may age before the panel stops presenting it as current. */
const STALE_AFTER_MS = 15_000;

type HubSnapshot = {
  readonly status: HubConnectorStatus;
  readonly identity: HubIdentitySummary;
  readonly enrollment: HubEnrollmentCeremonyDetail | null;
  readonly readAt: number;
};

const ACTION_LABELS: Record<Exclude<HubAction, "none">, string> = {
  enable: "Enable",
  disable: "Turn off",
  enroll: "Start enrollment",
  "cancel-enrollment": "Cancel",
  "open-hub": "Open Hub",
  retry: "Retry now",
  leave: "Leave this Hub",
  restart: "Restart Ryco",
};

const VERIFICATION_METADATA_BOOTSTRAP_MS = 10_000;

export function HubSection({
  desktopBridge,
}: {
  readonly desktopBridge: typeof window.desktopBridge;
}) {
  const nowMs = useRelativeTimeTick(1_000);
  const desktopWorkspace = useDesktopWorkspaceState();
  const [snapshot, setSnapshot] = useState<HubSnapshot | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const interactiveWorkspaceReleasesRef = useRef(new Map<string, () => void>());
  const closeSettings = useSettingsDialogStore((state) => state.closeSettings);
  const [verificationTarget, setVerificationTarget] = useState<{
    readonly nodeId: string;
    readonly environmentId: string;
    readonly handle: string;
  } | null>(null);
  const [verificationPayload, setVerificationPayload] = useState("");
  const [config, setConfig] = useState<DesktopHubLaunchConfig | null>(null);
  const [originDraft, setOriginDraft] = useState("");
  const [originError, setOriginError] = useState<string | null>(null);
  const [originSuggestion, setOriginSuggestion] = useState<string | null>(null);
  const [nodeNameDraft, setNodeNameDraft] = useState("");
  const [nodeNameError, setNodeNameError] = useState<string | null>(null);
  const [savingNodeName, setSavingNodeName] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<HubAction | null>(null);
  const [savingFileFallback, setSavingFileFallback] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [hostedIdentity, setHostedIdentity] = useState<DesktopHostedIdentityState | null>(null);
  const [hostedIdentityPending, setHostedIdentityPending] = useState(false);
  const [hostedIdentityError, setHostedIdentityError] = useState<string | null>(null);
  const [hostedGitHubPending, setHostedGitHubPending] = useState(false);
  const [hostedGitHubError, setHostedGitHubError] = useState<string | null>(null);
  const [hostedGitHubDisconnectOpen, setHostedGitHubDisconnectOpen] = useState(false);
  const [hostedGitHubStepUp, setHostedGitHubStepUp] = useState<"connect" | "disconnect" | null>(
    null,
  );
  const [hostedGitHubTotpCode, setHostedGitHubTotpCode] = useState("");
  const mountedRef = useRef(true);
  const pollerRef = useRef<VisibilityAwarePoller | null>(null);
  const { copyToClipboard } = useCopyToClipboard();
  // Same derivation the pairing rows use: clipboard writes need a secure context.
  const canCopyToClipboard =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [status, identity] = await Promise.all([fetchHubStatus(), fetchHubIdentity()]);
      // Only ask for the ceremony when one can exist; a 404 is the normal answer
      // otherwise and would be noise on every poll.
      const enrollment = status.state === "awaiting_approval" ? await fetchHubEnrollment() : null;
      if (!mountedRef.current) return;
      setSnapshot({ status, identity, enrollment, readAt: Date.now() });
      setError(null);
    } catch (cause) {
      if (!mountedRef.current) return;
      // Keep the last good snapshot, but stop calling it current. See the
      // staleness note below. Never let a dead control plane keep rendering
      // "Connected".
      setError(cause instanceof Error ? cause.message : "Unable to read Hub status.");
    }
  }, []);

  useEffect(() => {
    const poller = createVisibilityAwarePoller({
      lifecycle: webAppLifecycle,
      run: refresh,
      resolveDelayMs: () => HUB_STATUS_POLL_MS,
      jitterRatio: 0.1,
    });
    pollerRef.current = poller;
    return () => {
      if (pollerRef.current === poller) pollerRef.current = null;
      poller.stop();
    };
  }, [refresh]);

  const refreshCurrent = useCallback(() => pollerRef.current?.refresh() ?? refresh(), [refresh]);

  useEffect(() => {
    if (!desktopBridge) return;
    void desktopBridge
      .getHubLaunchConfig()
      .then((value) => {
        if (!mountedRef.current) return;
        setConfig(value);
        setOriginDraft(value.origin ?? "");
        setNodeNameDraft(value.nodeName ?? "");
        setConfigError(null);
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current) return;
        setConfigError(
          cause instanceof Error ? cause.message : "Unable to read Hub launch configuration.",
        );
      });
  }, [desktopBridge]);

  useEffect(
    () => () => {
      for (const release of interactiveWorkspaceReleasesRef.current.values()) release();
      interactiveWorkspaceReleasesRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!desktopBridge?.getHostedIdentityState) return;
    void desktopBridge
      .getHostedIdentityState()
      .then((value) => {
        if (!mountedRef.current) return;
        setHostedIdentity(value);
        setHostedIdentityError(null);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setHostedIdentity({ status: "unavailable" });
        setHostedIdentityError("Unable to read the native account setup state.");
      });
  }, [desktopBridge]);

  const runHostedIdentityAction = useCallback(
    async (action: "connect" | "disconnect") => {
      const invoke =
        action === "connect"
          ? desktopBridge?.connectHostedIdentity
          : desktopBridge?.disconnectHostedIdentity;
      if (!invoke) return;
      setHostedIdentityPending(true);
      setHostedIdentityError(null);
      try {
        const next = await invoke();
        if (!mountedRef.current) return;
        setHostedIdentity(next);
      } catch {
        if (!mountedRef.current) return;
        setHostedIdentity({ status: "unavailable" });
        setHostedIdentityError(
          action === "connect"
            ? "Automatic secure setup did not finish. Retry when the Hub is reachable."
            : "Unable to clear the native account session.",
        );
      } finally {
        if (mountedRef.current) setHostedIdentityPending(false);
      }
    },
    [desktopBridge],
  );

  const refreshDesktopWorkspace = useCallback(async () => {
    if (!desktopBridge?.refreshDesktopWorkspaceCatalog) return;
    setWorkspaceError(null);
    try {
      await desktopBridge.refreshDesktopWorkspaceCatalog();
    } catch {
      setWorkspaceError("Unable to refresh this account's machine directory.");
    }
  }, [desktopBridge]);

  useEffect(() => {
    if (hostedIdentity?.status === "ready") void refreshDesktopWorkspace();
  }, [hostedIdentity?.status, refreshDesktopWorkspace]);

  const connectDesktopMachine = useCallback((environmentId: EnvironmentId) => {
    if (interactiveWorkspaceReleasesRef.current.has(environmentId)) return;
    interactiveWorkspaceReleasesRef.current.set(
      environmentId,
      retainDesktopWorkspaceInteractiveScope(environmentId),
    );
  }, []);

  const disconnectDesktopMachine = useCallback((environmentId: EnvironmentId) => {
    interactiveWorkspaceReleasesRef.current.get(environmentId)?.();
    interactiveWorkspaceReleasesRef.current.delete(environmentId);
  }, []);

  const openDesktopMachine = useCallback(
    (environmentId: EnvironmentId) => {
      connectDesktopMachine(environmentId);
      useStore.getState().setActiveEnvironmentId(environmentId);
      closeSettings();
    },
    [closeSettings, connectDesktopMachine],
  );

  const verifyDesktopMachine = useCallback(async () => {
    if (!desktopBridge?.verifyDesktopWorkspaceApproval || !verificationTarget) return;
    setWorkspaceError(null);
    try {
      await desktopBridge.verifyDesktopWorkspaceApproval({
        nodeId: verificationTarget.nodeId,
        environmentId: EnvironmentId.make(verificationTarget.environmentId),
        payload: verificationPayload.trim(),
      });
      // A new trust record has no cached project/thread snapshot yet. Retain one
      // bounded provider-status scope to populate it, then return connection
      // ownership to mounted thread/VCS/provider scopes.
      const releaseBootstrap = retainDesktopWorkspaceProviderScope(
        EnvironmentId.make(verificationTarget.environmentId),
      );
      globalThis.setTimeout(releaseBootstrap, VERIFICATION_METADATA_BOOTSTRAP_MS);
      await desktopBridge
        .cancelDesktopWorkspaceVerification?.(verificationTarget.handle)
        .catch(() => undefined);
      setVerificationTarget(null);
      setVerificationPayload("");
    } catch {
      setWorkspaceError(
        "That approval code does not match this Desktop client, machine, account, or current node security state.",
      );
    }
  }, [desktopBridge, verificationPayload, verificationTarget]);

  const beginDesktopMachineVerification = useCallback(
    async (input: { readonly nodeId: string; readonly environmentId: string }) => {
      if (!desktopBridge?.beginDesktopWorkspaceVerification) return;
      setWorkspaceError(null);
      try {
        if (verificationTarget) {
          await desktopBridge
            .cancelDesktopWorkspaceVerification?.(verificationTarget.handle)
            .catch(() => undefined);
        }
        const prepared = await desktopBridge.beginDesktopWorkspaceVerification({
          nodeId: input.nodeId,
          environmentId: EnvironmentId.make(input.environmentId),
        });
        setVerificationTarget({ ...input, handle: prepared.handle });
        setVerificationPayload("");
      } catch {
        setWorkspaceError(
          "Unable to introduce this Desktop client to that machine. Confirm it is online and retry.",
        );
      }
    },
    [desktopBridge, verificationTarget],
  );

  const runHostedGitHubAction = useCallback(
    async (action: "connect" | "disconnect", totpCode?: string) => {
      const invoke =
        action === "connect"
          ? desktopBridge?.connectHostedGitHub
          : desktopBridge?.disconnectHostedGitHub;
      if (!invoke) return;
      setHostedGitHubPending(true);
      setHostedGitHubError(null);
      try {
        const result = await invoke(totpCode ? { totpCode } : undefined);
        if (!mountedRef.current) return;
        setHostedIdentity(result.state);
        if (result.outcome === "step-up-required") {
          setHostedGitHubStepUp(action);
          setHostedGitHubTotpCode("");
        } else {
          setHostedGitHubStepUp(null);
          setHostedGitHubTotpCode("");
          setHostedGitHubDisconnectOpen(false);
          if (result.outcome === "last-primary-credential") {
            setHostedGitHubError("Add another primary sign-in method before disconnecting GitHub.");
          } else if (result.outcome === "unavailable") {
            setHostedGitHubError("GitHub account access is temporarily unavailable.");
          }
        }
      } catch {
        if (mountedRef.current) {
          setHostedGitHubError("GitHub account access is temporarily unavailable.");
        }
      } finally {
        if (mountedRef.current) setHostedGitHubPending(false);
      }
    },
    [desktopBridge],
  );

  const runAction = useCallback(
    async (action: HubAction) => {
      setPendingAction(action);
      setError(null);
      try {
        switch (action) {
          case "enroll":
            await startHubEnrollment();
            break;
          case "cancel-enrollment":
            await cancelHubEnrollment();
            break;
          case "retry":
            await resumeHubConnector();
            break;
          case "leave":
            await leaveHub();
            break;
          case "enable":
          case "disable":
            await desktopBridge?.setHubLaunchConfig({ enabled: action === "enable" });
            return; // The app relaunches; nothing after this runs.
          case "restart":
            if (!desktopBridge?.restartApp) throw new Error("Desktop restart is unavailable.");
            await desktopBridge.restartApp();
            return;
          case "open-hub": {
            // The origin root only. The node derives exactly one route from the
            // origin, so synthesising an approval path would invent a Hub
            // routing detail there is no contract for.
            const origin = config?.origin;
            if (origin) window.open(origin, "_blank", "noopener,noreferrer");
            return;
          }
          default:
            return;
        }
        await refreshCurrent();
      } catch (cause) {
        if (!mountedRef.current) return;
        setError(cause instanceof Error ? cause.message : "That didn't work.");
      } finally {
        if (mountedRef.current) setPendingAction(null);
      }
    },
    [config, desktopBridge, refreshCurrent],
  );

  const handleOriginBlur = useCallback(async () => {
    if (!desktopBridge || originDraft.trim() === "") {
      setOriginError(null);
      setOriginSuggestion(null);
      return;
    }
    const result = await desktopBridge.validateHubOrigin(originDraft);
    if (!mountedRef.current) return;
    if (result.ok) {
      setOriginDraft(result.origin);
      setOriginError(null);
      setOriginSuggestion(null);
      return;
    }
    setOriginSuggestion(result.suggestion ?? null);
    setOriginError(
      {
        empty: "Enter a Hub address.",
        too_long: "That address is too long.",
        not_a_url: "That doesn't look like an address.",
        insecure_scheme: "A Hub address must use https.",
        has_credentials: "Remove the username and password from the address.",
        has_path: "Use the Hub's address only, without a path.",
        invalid: "That address can't be used.",
      }[result.reason],
    );
  }, [desktopBridge, originDraft]);

  const saveOrigin = useCallback(
    async (origin: string) => {
      if (!desktopBridge) return;
      setPendingAction("enable");
      try {
        await desktopBridge.setHubLaunchConfig({ origin });
      } catch (cause) {
        if (!mountedRef.current) return;
        setError(cause instanceof Error ? cause.message : "Unable to save the Hub address.");
        setPendingAction(null);
      }
    },
    [desktopBridge],
  );

  const updateNodeNameDraft = useCallback((value: string) => {
    setNodeNameDraft(value);
    setNodeNameError(value.trim().length > 100 ? "Use 100 characters or fewer." : null);
  }, []);

  const saveNodeName = useCallback(async () => {
    if (!desktopBridge) return;
    const nodeName = nodeNameDraft.trim();
    if (nodeName.length > 100) {
      setNodeNameError("Use 100 characters or fewer.");
      return;
    }

    setSavingNodeName(true);
    setNodeNameError(null);
    try {
      await desktopBridge.setHubLaunchConfig({ nodeName: nodeName === "" ? null : nodeName });
    } catch (cause) {
      if (!mountedRef.current) return;
      setNodeNameError(
        cause instanceof Error ? cause.message : "Unable to save the Hub node name.",
      );
      setSavingNodeName(false);
    }
  }, [desktopBridge, nodeNameDraft]);

  const setFileSecretStoreFallback = useCallback(
    async (enabled: boolean) => {
      if (!desktopBridge) return;
      const confirmed = await desktopBridge.confirm(
        enabled
          ? "Allow permissioned-file storage when the system credential store is unavailable? Ryco will restart. Existing keys are not moved."
          : "Stop allowing permissioned-file Hub key storage? Ryco will restart.",
      );
      if (!confirmed || !mountedRef.current) return;
      setSavingFileFallback(true);
      setConfigError(null);
      try {
        await desktopBridge.setHubLaunchConfig({ allowFileSecretStore: enabled });
      } catch (cause) {
        if (!mountedRef.current) return;
        setConfigError(
          cause instanceof Error ? cause.message : "Unable to save the key storage setting.",
        );
        setSavingFileFallback(false);
      }
    },
    [desktopBridge],
  );

  const openRelayGuide = useCallback(async () => {
    if (!desktopBridge) return;
    try {
      const guideUrl = new URL(relayArchitectureGuideUrl, window.location.href).toString();
      const opened = await desktopBridge.openExternal(guideUrl);
      if (!opened) throw new Error("The relay guide could not be opened.");
      setConfigError(null);
    } catch (cause) {
      if (!mountedRef.current) return;
      setConfigError(cause instanceof Error ? cause.message : "Unable to open the relay guide.");
    }
  }, [desktopBridge]);

  if (!desktopBridge) return null;

  const stale = snapshot !== null && nowMs - snapshot.readAt > STALE_AFTER_MS;
  const presentation =
    snapshot === null ? null : presentHubStatus(snapshot.status, snapshot.identity, nowMs);
  const editable = snapshot === null ? false : canEditHubOrigin(snapshot.identity);
  const originChanged = originDraft.trim() !== (config?.origin ?? "");
  const nodeNameChanged = nodeNameDraft.trim() !== (config?.nodeName ?? "");
  const automaticNativeSetup =
    config !== null &&
    config.origin !== null &&
    desktopBridge.getHostedIdentityState !== undefined &&
    desktopBridge.connectHostedIdentity !== undefined &&
    snapshot?.identity.enrolled === "none";
  const automaticNativeSetupWaiting =
    automaticNativeSetup &&
    (presentation?.action === "enable" || presentation?.action === "enroll");

  const renderAction = (action: HubAction, variant: "outline" | "destructive-outline") =>
    action === "none" ? null : (
      <Button
        size="xs"
        variant={variant}
        disabled={pendingAction !== null}
        onClick={() => {
          if (action === "leave") {
            setLeaveOpen(true);
            return;
          }
          void runAction(action);
        }}
      >
        {pendingAction === action ? "Working…" : ACTION_LABELS[action]}
      </Button>
    );

  return (
    <SettingsSection title="Hub">
      <SettingsRow
        title="Connection"
        description={
          automaticNativeSetupWaiting
            ? "Connect your Ryco account below. Ryco will register this Mac with this Hub automatically."
            : presentation === null
              ? "Loading…"
              : presentation.detail === null
                ? "Reach this Mac from anywhere, including behind NAT or CGNAT, without opening a port."
                : presentation.detail
        }
        status={
          <>
            {presentation === null ? null : (
              <span className="flex items-center gap-1.5">
                <span
                  className={`inline-block size-2 shrink-0 rounded-full ${
                    stale
                      ? "bg-muted-foreground/40"
                      : presentation.dot === "success"
                        ? "bg-success"
                        : presentation.dot === "warning"
                          ? "bg-warning"
                          : presentation.dot === "destructive"
                            ? "bg-destructive"
                            : "bg-muted-foreground/40"
                  }`}
                  aria-hidden
                />
                {stale
                  ? `${presentation.headline} · last checked ${Math.round((nowMs - snapshot.readAt) / 1000)}s ago`
                  : automaticNativeSetupWaiting
                    ? "Ready for account setup"
                    : presentation.headline}
              </span>
            )}
            {error ? <span className="block text-destructive">{error}</span> : null}
          </>
        }
        control={
          presentation === null ? null : (
            <>
              {renderAction(
                automaticNativeSetupWaiting ? "none" : presentation.action,
                presentation.action === "leave" ? "destructive-outline" : "outline",
              )}
              {renderAction(
                automaticNativeSetupWaiting ? "none" : presentation.secondaryAction,
                presentation.secondaryAction === "leave" ? "destructive-outline" : "outline",
              )}
            </>
          )
        }
      >
        <AnimatedHeight>
          {snapshot?.enrollment ? (
            <div className="pb-3.5">
              <p className="pb-2 text-xs text-muted-foreground/80">
                Compare every field with the Hub&apos;s approval screen before approving.
              </p>
              {/* The same primitive, fields and order the approval screen uses.
                  A fingerprint that wraps differently on the two screens a
                  reviewer holds side by side is a security-review finding, so
                  `mono` owns that decision in one place rather than here. */}
              <DataList className="rounded-xl border border-border/60 bg-muted/20 p-3">
                <DataListItem term="Label">{snapshot.enrollment.label}</DataListItem>
                <DataListItem term="Platform">
                  {`${snapshot.enrollment.platformOs} · ${snapshot.enrollment.platformArch}`}
                </DataListItem>
                <DataListItem term="Version" mono>
                  {snapshot.enrollment.clientVersion}
                </DataListItem>
                <DataListItem term="Algorithm">{snapshot.enrollment.algorithm}</DataListItem>
                <DataListItem term="Fingerprint" mono>
                  {snapshot.enrollment.fingerprint}
                </DataListItem>
                <DataListItem term="Expires">
                  {new Date(snapshot.enrollment.expiresAt).toLocaleString()}
                </DataListItem>
                {/* Copy belongs on the device code, not the fingerprint: the
                    Hub's entry point is a device-code field, and there is
                    nowhere to paste a fingerprint. */}
                <DataListItem
                  term="Device code"
                  mono
                  action={
                    canCopyToClipboard ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => copyToClipboard(snapshot.enrollment!.deviceCode)}
                      >
                        Copy
                      </Button>
                    ) : null
                  }
                >
                  {snapshot.enrollment.deviceCode}
                </DataListItem>
              </DataList>
              <p className="pt-2 text-[11px] text-muted-foreground/70">
                The device code only routes the request. It does not prove which machine you are
                approving.
              </p>
              <p className="flex items-center gap-1.5 pt-2 text-xs text-warning">
                <TriangleAlertIcon className="size-3.5 shrink-0" />
                If the fingerprint on the Hub differs by even one character, deny it there and
                cancel here.
              </p>
            </div>
          ) : null}
        </AnimatedHeight>
      </SettingsRow>

      {config !== null &&
      config.origin !== null &&
      desktopBridge.getHostedIdentityState !== undefined ? (
        <SettingsRow
          title="Ryco account"
          description={
            hostedIdentity === null
              ? "Checking this Mac's native account setup…"
              : automaticNativeSetupWaiting && hostedIdentity.status === "ready"
                ? "You are signed in. Finish setup to register this Mac with the Hub and verify local trust automatically."
                : hostedIdentity.status === "ready"
                  ? "You are signed in. Ryco chooses this device's secure connection automatically; this Mac's node status is shown above."
                  : hostedIdentity.status === "signed-out"
                    ? "Sign in in your browser. Ryco will claim this Mac's node and verify its local trust automatically."
                    : "Automatic secure setup did not finish. Existing node and trust state are preserved while you retry."
          }
          status={
            <>
              {hostedIdentity === null ? null : (
                <span className="flex items-center gap-1.5">
                  <span
                    className={`inline-block size-2 shrink-0 rounded-full ${
                      automaticNativeSetupWaiting && hostedIdentity.status === "ready"
                        ? "bg-warning"
                        : hostedIdentity.status === "ready"
                          ? "bg-success"
                          : hostedIdentity.status === "unavailable"
                            ? "bg-warning"
                            : "bg-muted-foreground/40"
                    }`}
                    aria-hidden
                  />
                  {hostedIdentity.status === "ready"
                    ? automaticNativeSetupWaiting
                      ? "Signed in · Node setup needed"
                      : "Secure setup complete"
                    : hostedIdentity.status === "unavailable"
                      ? "Setup needs attention"
                      : "Not signed in"}
                </span>
              )}
              {hostedIdentityError ? (
                <span className="block text-destructive">{hostedIdentityError}</span>
              ) : null}
            </>
          }
          control={
            hostedIdentity === null ? null : automaticNativeSetupWaiting &&
              hostedIdentity.status === "ready" ? (
              <Button
                size="xs"
                disabled={hostedIdentityPending || !desktopBridge.connectHostedIdentity}
                onClick={() => void runHostedIdentityAction("connect")}
              >
                {hostedIdentityPending ? "Finishing setup…" : "Finish setup"}
              </Button>
            ) : hostedIdentity.status === "ready" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={hostedIdentityPending || !desktopBridge.disconnectHostedIdentity}
                onClick={() => void runHostedIdentityAction("disconnect")}
              >
                {hostedIdentityPending ? "Working…" : "Sign out"}
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={hostedIdentityPending || !desktopBridge.connectHostedIdentity}
                onClick={() => void runHostedIdentityAction("connect")}
              >
                {hostedIdentityPending
                  ? "Opening browser…"
                  : hostedIdentity.status === "unavailable"
                    ? "Retry secure setup"
                    : "Connect account"}
              </Button>
            )
          }
        />
      ) : null}

      {hostedIdentity?.status === "ready" && desktopBridge?.getDesktopWorkspaceState ? (
        <SettingsRow
          title="Workspace machines"
          description="Connect, open, and manage each machine independently. Cached lists remain read-only until connected."
          status={
            workspaceError ??
            `${desktopWorkspace.machines.filter((machine) => machine.online).length} online · ${desktopWorkspace.activeConnectionCount} connected`
          }
          control={
            <Button size="xs" variant="outline" onClick={() => void refreshDesktopWorkspace()}>
              Refresh
            </Button>
          }
        >
          <DataList>
            {desktopWorkspace.machines.map((machine) => (
              <DataListItem
                key={`${machine.nodeId ?? "unknown"}:${machine.environmentId}`}
                term={machine.label}
                action={
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {machine.nodeId &&
                    machine.online &&
                    (machine.nativeTrust === "unverified" ||
                      machine.nativeTrust === "unknown" ||
                      machine.nativeTrust === "account-trusted") ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          void beginDesktopMachineVerification({
                            nodeId: machine.nodeId!,
                            environmentId: machine.environmentId,
                          });
                        }}
                      >
                        {machine.nativeTrust === "account-trusted"
                          ? "Verify independently"
                          : "Verify"}
                      </Button>
                    ) : null}
                    {(machine.nativeTrust === "verified" ||
                      machine.nativeTrust === "account-trusted") &&
                    machine.online ? (
                      machine.connectionState === "connected" ? (
                        <>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => openDesktopMachine(machine.environmentId)}
                          >
                            Open
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => disconnectDesktopMachine(machine.environmentId)}
                          >
                            Disconnect
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => connectDesktopMachine(machine.environmentId)}
                        >
                          Connect
                        </Button>
                      )
                    ) : null}
                  </div>
                }
              >
                {machine.nativeTrust === "verified"
                  ? machine.online
                    ? `Encrypted · Verified locally · ${machine.connectionState === "connected" ? "Connected" : "Online"}`
                    : "Encrypted · Verified locally · Offline"
                  : machine.nativeTrust === "account-trusted"
                    ? machine.online
                      ? `Encrypted · Account trusted · ${machine.connectionState === "connected" ? "Connected" : "Online"}`
                      : "Encrypted · Account trusted · Offline"
                    : machine.nativeTrust === "identity-conflict"
                      ? "Identity changed · Locked"
                      : machine.online
                        ? "Needs verification"
                        : "Needs verification · Offline"}
              </DataListItem>
            ))}
          </DataList>
          {verificationTarget ? (
            <div className="mt-3 flex flex-col gap-2 border-t border-border/60 py-3 sm:flex-row">
              <Input
                value={verificationPayload}
                onChange={(event) => setVerificationPayload(event.target.value)}
                placeholder="Paste the approval code shown by this exact node"
                aria-label="Machine approval code"
              />
              <Button
                size="sm"
                disabled={verificationPayload.trim().length === 0}
                onClick={() => void verifyDesktopMachine()}
              >
                Verify
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void desktopBridge
                    .cancelDesktopWorkspaceVerification?.(verificationTarget.handle)
                    .catch(() => undefined);
                  setVerificationTarget(null);
                  setVerificationPayload("");
                }}
              >
                Cancel
              </Button>
            </div>
          ) : null}
        </SettingsRow>
      ) : null}

      {hostedIdentity?.status === "ready" && hostedIdentity.github !== undefined ? (
        <SettingsRow
          title={
            hostedIdentity.github.identity
              ? `GitHub · @${hostedIdentity.github.identity.login}`
              : "GitHub"
          }
          description={
            hostedIdentity.github.identity
              ? "Use this GitHub identity to sign in to Ryco. Repository access remains separate."
              : "Connect GitHub as another way to sign in. Ryco requests no repository access."
          }
          status={
            hostedGitHubError ? (
              <span className="block text-destructive">{hostedGitHubError}</span>
            ) : hostedIdentity.github.identity?.displayName ? (
              hostedIdentity.github.identity.displayName
            ) : null
          }
          control={
            !hostedIdentity.github.linkAvailable ? null : hostedIdentity.github.identity ? (
              <Button
                size="xs"
                variant="outline"
                disabled={hostedGitHubPending || !desktopBridge?.disconnectHostedGitHub}
                onClick={() => setHostedGitHubDisconnectOpen(true)}
              >
                {hostedGitHubPending ? "Working…" : "Disconnect"}
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={hostedGitHubPending || !desktopBridge?.connectHostedGitHub}
                onClick={() => void runHostedGitHubAction("connect")}
              >
                {hostedGitHubPending ? "Opening browser…" : "Connect GitHub"}
              </Button>
            )
          }
        />
      ) : null}

      <SettingsRow
        title="Hub address"
        description={
          editable
            ? "The address of the Hub you or your team operate."
            : "Locked while this machine is enrolled. Leave this Hub to change it."
        }
        status={
          originError ? (
            <span className="block text-destructive">
              {originError}
              {originSuggestion ? (
                <button
                  type="button"
                  className="ml-1 underline underline-offset-2"
                  onClick={() => {
                    setOriginDraft(originSuggestion);
                    setOriginError(null);
                    setOriginSuggestion(null);
                  }}
                >
                  Use {originSuggestion}
                </button>
              ) : null}
            </span>
          ) : null
        }
        control={
          <>
            <Input
              value={originDraft}
              disabled={!editable || pendingAction !== null}
              placeholder="https://…"
              className="w-64 font-mono text-xs"
              onChange={(event) => setOriginDraft(event.currentTarget.value)}
              onBlur={() => void handleOriginBlur()}
            />
            {editable && originChanged && originError === null && originDraft.trim() !== "" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pendingAction !== null}
                onClick={() => void saveOrigin(originDraft.trim())}
              >
                Save and restart
              </Button>
            ) : null}
          </>
        }
      />

      <SettingsRow
        title="Device name"
        description={
          editable
            ? "Choose the name proposed on the Hub approval screen. Leave it blank for a stable automatic name."
            : snapshot?.identity.enrolled === "pending"
              ? "Locked while enrollment is pending. Cancel enrollment to change the proposed name."
              : "After enrollment, rename the device in Device settings or its Hub details. The name is shared across your apps."
        }
        status={
          nodeNameError ? <span className="block text-destructive">{nodeNameError}</span> : null
        }
        control={
          <>
            <Input
              value={nodeNameDraft}
              disabled={!editable || pendingAction !== null || savingNodeName}
              placeholder="Automatic: machine name · node code"
              aria-label="Hub node name"
              className="w-64 text-xs"
              onChange={(event) => updateNodeNameDraft(event.currentTarget.value)}
            />
            {editable && nodeNameChanged && nodeNameError === null ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pendingAction !== null || savingNodeName}
                onClick={() => void saveNodeName()}
              >
                {savingNodeName ? "Saving…" : "Save and restart"}
              </Button>
            ) : null}
          </>
        }
      />

      {snapshot !== null && snapshot.status.state === "online" ? (
        <SettingsRow
          title="Who can connect"
          description="Managed on the Hub, not here. Sessions arriving through the Hub carry a role: viewer reads, operator edits files and runs terminals, owner also changes credentials and server policy."
        />
      ) : null}

      <HubAdvancedOptions
        config={config}
        identity={snapshot?.identity ?? null}
        status={snapshot?.status ?? null}
        nowMs={nowMs}
        savingFileFallback={savingFileFallback || pendingAction !== null}
        configError={configError}
        onFileFallbackChange={(enabled) => void setFileSecretStoreFallback(enabled)}
        onOpenGuide={() => void openRelayGuide()}
      />

      <AlertDialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this Hub?</AlertDialogTitle>
            <AlertDialogDescription>
              This erases this machine&apos;s Hub key. You can enrol again afterwards, but it will
              join as a new machine and needs a new approval.
              <br />
              <br />
              It does <strong>not</strong> revoke anything on the Hub. The old entry stays there
              until an owner removes it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose>Keep it</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pendingAction !== null}
              onClick={() => {
                setLeaveOpen(false);
                void runAction("leave");
              }}
            >
              Erase this machine&apos;s key
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog open={hostedGitHubDisconnectOpen} onOpenChange={setHostedGitHubDisconnectOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect GitHub?</AlertDialogTitle>
            <AlertDialogDescription>
              GitHub stops working as a Ryco sign-in method. Ryco refuses this change when it is
              your only primary sign-in method. Repository access is separate.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={hostedGitHubPending}
              onClick={() => void runHostedGitHubAction("disconnect")}
            >
              Disconnect GitHub
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        open={hostedGitHubStepUp !== null}
        onOpenChange={(open) => {
          if (!open && !hostedGitHubPending) {
            if (hostedGitHubStepUp === "connect") {
              void desktopBridge?.cancelHostedGitHubConnection?.();
            }
            setHostedGitHubStepUp(null);
            setHostedGitHubTotpCode("");
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm this account change</AlertDialogTitle>
            <AlertDialogDescription>
              Enter a current code from your authenticator app. The pending GitHub authorization is
              reused; Ryco does not reopen the browser.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            aria-label="Authenticator code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={16}
            value={hostedGitHubTotpCode}
            onChange={(event) =>
              setHostedGitHubTotpCode(event.currentTarget.value.replace(/\D/gu, ""))
            }
          />
          <AlertDialogFooter>
            <AlertDialogClose>Cancel</AlertDialogClose>
            <Button
              disabled={hostedGitHubPending || hostedGitHubTotpCode.length < 6}
              onClick={() => {
                if (hostedGitHubStepUp !== null) {
                  void runHostedGitHubAction(hostedGitHubStepUp, hostedGitHubTotpCode);
                }
              }}
            >
              Confirm
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
