import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  CheckIcon,
  FolderOpenIcon,
  MessageSquareIcon,
  MonitorSmartphoneIcon,
  SettingsIcon,
  GitBranchIcon,
  type LucideIcon,
} from "lucide-react";
import {
  WS_METHODS,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@ryco/contracts";
import { canOfferProviderSignIn } from "@ryco/shared/providerSignIn";
import { readEnvironmentApi } from "../../environmentApi";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import {
  preloadableLazy,
  useLazyComponentReady,
  usePreloadWhenIdle,
} from "../../lib/preloadableLazy";
import { getWsConnectionStatusForEnvironment } from "../../rpc/wsConnectionState";
import { applyProvidersUpdated, usePrimaryServerConfigSelector } from "../../rpc/serverState";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { cn } from "../../lib/utils";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import {
  openProjectImportDialog,
  preloadProjectImportDialog,
} from "../projectImport/projectImportDialogStore";
import { getProviderSummary } from "../settings/providerStatus";
import { PROVIDER_CLIENT_DEFINITIONS } from "../settings/providerDriverMeta";
import { PAIRING_LINK_TARGET_ID, requestSettingsReveal } from "../settings/settingsSearchReveal";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { notifySurfaceLoadFailure } from "../ui/surfaceLoadFailure";
import { ONBOARDING_STEPS, type OnboardingOutcome, type OnboardingStep } from "./onboardingState";
import { useWindowFolderDrop } from "./useWindowFolderDrop";

const STEP_LABELS = { providers: "Providers", project: "Project", tour: "Quick tour" };
const PROVIDER_GUIDES: Readonly<Record<string, string>> = {
  codex: "https://github.com/saka-gg/ryco/blob/main/docs/providers/codex.md",
  claudeAgent: "https://github.com/saka-gg/ryco/blob/main/docs/providers/claude.md",
};

// Loads on the first Sign in: it brings the client-runtime sign-in controller, which setup
// without a sign-in never needs.
const ProviderSignInSection = preloadableLazy(() =>
  import("../settings/ProviderSignInSection").then((module) => module.ProviderSignInSection),
);

function providerName(provider: ServerProvider): string {
  return (
    provider.displayName ??
    PROVIDER_CLIENT_DEFINITIONS.find((item) => item.value === provider.driver)?.label ??
    provider.driver
  );
}

// A terminal sign-in (xterm) takes Escape for itself; anywhere else Escape still closes setup.
function keepTerminalEscape(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "Escape" && event.target instanceof Element && event.target.closest(".xterm")) {
    event.stopPropagation();
  }
}

interface TourItem {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly text: string;
  /** Rows in Settings → Connections to reveal; setup links to them and adds no flow of its own. */
  readonly actions?: readonly { readonly label: string; readonly reveal: string }[];
}

/** `desktop`: Connections shows the Hub section only in the desktop app. */
function tourItems(desktop: boolean): readonly TourItem[] {
  return [
    {
      icon: MessageSquareIcon,
      title: "Start a task",
      text: "Choose a project, open a new task, and pick your provider and model before sending a request.",
    },
    {
      icon: GitBranchIcon,
      title: "Review the work",
      text: "Follow the conversation, answer approval requests, and inspect changes in the workspace panel.",
    },
    {
      icon: SettingsIcon,
      title: "Make it yours",
      text: "Use Settings for providers and preferences. Replay this tour from This app or This browser → General.",
    },
    {
      icon: MonitorSmartphoneIcon,
      title: "Use Ryco on your other devices",
      text: "Open this computer on your phone or another browser with a pairing link, or connect more computers.",
      actions: [
        { label: "Pairing link", reveal: PAIRING_LINK_TARGET_ID },
        { label: "Connect a computer", reveal: "Remote environments" },
        ...(desktop ? [{ label: "Ryco Hub", reveal: "Hub" }] : []),
      ],
    },
  ];
}

/** Opens Settings → Connections on this app and scrolls to `target`. */
function revealConnectionsSetting(target: string) {
  useSettingsDialogStore.getState().openSettings("connections");
  requestSettingsReveal(target);
}

export interface OnboardingDialogProps {
  environmentId: EnvironmentId;
  providers: readonly ServerProvider[];
  projectCount: number;
  ready: boolean;
  connectionGeneration: string | null;
  open: boolean;
  onComplete: (outcome: Exclude<OnboardingOutcome, "existing">) => void;
}

export function OnboardingDialog({
  environmentId,
  providers,
  projectCount,
  ready,
  connectionGeneration,
  open,
  onComplete,
}: OnboardingDialogProps) {
  const [step, setStep] = useState<OnboardingStep>("providers");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshingRef = useRef(false);
  const generation = useRef(0);
  // hosted-capability: routed node
  const refreshCapability = useHostedRpcCapability(WS_METHODS.serverRefreshProviders, null);
  // hosted-capability: routed node
  const settingsCapability = useHostedRpcCapability(WS_METHODS.serverUpdateSettings, null);
  // hosted-capability: routed node
  const projectCapability = useHostedRpcCapability(WS_METHODS.projectsAdd, null);
  // hosted-capability: routed node
  const signInCapability = useHostedRpcCapability(WS_METHODS.providerSignInStart, null);
  const providerInstances = usePrimaryServerConfigSelector(
    (config) => config?.settings.providerInstances,
  );
  // One provider signs in at a time, below the list; the flow itself is the node's.
  const [signingIn, setSigningIn] = useState<ProviderInstanceId | null>(null);
  const signInRegion = useRef<HTMLDivElement>(null);
  const signInRegionId = useId();
  const stepIndex = ONBOARDING_STEPS.indexOf(step);
  const offersSignIn = (provider: ServerProvider) =>
    canOfferProviderSignIn({
      provider,
      instance: providerInstances?.[provider.instanceId],
      capabilityAllowed: signInCapability.allowed,
    });
  const anySignIn = step === "providers" && providers.some(offersSignIn);
  const signInProvider =
    step === "providers" && signingIn !== null
      ? providers.find((provider) => provider.instanceId === signingIn)
      : undefined;
  const signInReady = useLazyComponentReady(ProviderSignInSection, signInProvider !== undefined, {
    onLoadError: (loadError, retry) =>
      notifySurfaceLoadFailure("provider sign-in", loadError, retry),
  });
  const shownSignIn =
    signInProvider !== undefined && signInReady ? signInProvider.instanceId : null;
  usePreloadWhenIdle(ProviderSignInSection, anySignIn);
  // Only Ryco Desktop can read a dropped folder's absolute path. Bound while
  // the project step shows, so a drop with Settings or the picker open, or
  // while reconnecting, is not taken.
  const folderDropEnabled =
    open &&
    step === "project" &&
    ready &&
    projectCapability.allowed &&
    window.desktopBridge?.getPathForFile !== undefined;
  const folderDrop = useWindowFolderDrop({
    enabled: folderDropEnabled,
    // The palette's add-project path dedupes, creates and opens the project.
    onFolder: (path) => useCommandPaletteStore.getState().openAddProject({ path, environmentId }),
  });

  useEffect(() => {
    generation.current += 1;
    refreshingRef.current = false;
    setRefreshing(false);
    setError(null);
    return () => {
      generation.current += 1;
    };
  }, [connectionGeneration, environmentId, ready]);

  useEffect(() => {
    if (shownSignIn === null) return;
    const frame = requestAnimationFrame(() => {
      signInRegion.current?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [shownSignIn]);

  const refresh = async () => {
    if (!ready || !refreshCapability.allowed || refreshingRef.current) return;
    const api = readEnvironmentApi(environmentId);
    if (!api?.server) {
      setError("This machine is unavailable. Wait for it to reconnect, then refresh.");
      return;
    }
    const attempt = generation.current;
    const isCurrentAttempt = () => {
      const connection = getWsConnectionStatusForEnvironment(environmentId);
      return (
        attempt === generation.current &&
        connection.phase === "connected" &&
        connection.connectedAt === connectionGeneration
      );
    };
    refreshingRef.current = true;
    setRefreshing(true);
    setError(null);
    try {
      const result = await api.server.refreshProviders();
      if (isCurrentAttempt()) applyProvidersUpdated(result);
    } catch {
      if (isCurrentAttempt())
        setError("Provider discovery failed. Try refreshing again or open Provider settings.");
    } finally {
      if (attempt === generation.current) {
        refreshingRef.current = false;
        setRefreshing(false);
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onComplete("skipped");
      }}
    >
      <DialogPopup className="max-w-2xl" bottomStickOnMobile={false}>
        <DialogHeader>
          <p className="text-xs font-medium tracking-wide text-muted-foreground">
            WELCOME TO RYCO · {stepIndex + 1} OF {ONBOARDING_STEPS.length}
          </p>
          <DialogTitle>
            {step === "providers"
              ? "Bring your coding agent"
              : step === "project"
                ? "Choose a place to work"
                : "Your first task, in three moves"}
          </DialogTitle>
          <DialogDescription>
            {step === "providers"
              ? "Ryco uses the providers on this machine. Set one up now or come back later."
              : step === "project"
                ? "Add an existing folder or use the project picker to create or clone a project."
                : "You’re ready to start. These essentials are always within reach."}
          </DialogDescription>
          <ol aria-label="Setup progress" className="mt-2 flex gap-5 text-xs text-muted-foreground">
            {ONBOARDING_STEPS.map((item, index) => (
              <li
                key={item}
                aria-current={step === item ? "step" : undefined}
                className={step === item ? "font-semibold text-foreground" : ""}
              >
                {index + 1}. {STEP_LABELS[item]}
              </li>
            ))}
          </ol>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {!ready && (
            <p role="status" className="rounded-lg border p-3 text-sm text-muted-foreground">
              Reconnecting to this machine. Setup actions will be available when its current
              workspace is ready.
            </p>
          )}
          {step === "providers" && (
            <>
              <ul aria-label="Detected providers" className="divide-y rounded-xl border px-4">
                {providers.map((provider) => {
                  const summary =
                    provider.availability === "unavailable"
                      ? { headline: "Driver unavailable" }
                      : getProviderSummary(provider);
                  const name = providerName(provider);
                  const guide = PROVIDER_GUIDES[provider.driver];
                  const expanded = signingIn === provider.instanceId;
                  return (
                    <li
                      key={provider.instanceId}
                      className="flex items-start justify-between gap-4 py-3"
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium">{name}</p>
                        <p className="text-xs text-muted-foreground">
                          {summary.headline}
                          {provider.enabled &&
                          provider.installed &&
                          provider.auth.status === "unknown"
                            ? " · Authentication not verified"
                            : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        {guide && (
                          <a
                            href={guide}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs underline underline-offset-4"
                          >
                            Setup guide<span className="sr-only"> for {name}</span>
                          </a>
                        )}
                        {offersSignIn(provider) && (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={!ready}
                            aria-expanded={expanded}
                            aria-controls={expanded ? signInRegionId : undefined}
                            onClick={() =>
                              setSigningIn((current) =>
                                current === provider.instanceId ? null : provider.instanceId,
                              )
                            }
                          >
                            {expanded ? (
                              <>
                                Hide sign-in<span className="sr-only"> for {name}</span>
                              </>
                            ) : (
                              <>
                                Sign in<span className="sr-only"> to {name}</span>
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
                {providers.length === 0 && (
                  <li className="py-4 text-sm text-muted-foreground">
                    No provider status yet. Refresh discovery or add an instance in Provider
                    settings.
                  </li>
                )}
              </ul>
              {signInProvider !== undefined && signInReady && (
                <div
                  ref={signInRegion}
                  id={signInRegionId}
                  className="scroll-my-4 rounded-xl border p-4 empty:hidden"
                  onKeyDown={keepTerminalEscape}
                >
                  <ProviderSignInSection
                    key={signInProvider.instanceId}
                    environmentId={environmentId}
                    nodeLabel="this machine"
                    connected={ready}
                    instanceId={signInProvider.instanceId}
                    instanceEnabled={signInProvider.enabled}
                    displayName={providerName(signInProvider)}
                    provider={signInProvider}
                    variant="inline"
                    onStateChange={(state) => {
                      // Done: the providers stream already shows the row signed in. A failure or
                      // an expired code stays open so its message can be read.
                      if (state.phase === "succeeded") {
                        setSigningIn((current) => (current === state.instanceId ? null : current));
                      }
                    }}
                  />
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                {anySignIn
                  ? "Sign in here, or install and sign in with your provider’s own CLI on this machine and refresh."
                  : "Install and sign in with your provider’s own CLI on this machine, then refresh."}{" "}
                Use Provider settings for custom binary paths, separate accounts, or API keys.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!ready || refreshing || !refreshCapability.allowed}
                  onClick={() => void refresh()}
                >
                  {refreshing ? "Checking providers…" : "Refresh discovery"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={!ready || !settingsCapability.allowed}
                  onClick={() =>
                    useSettingsDialogStore.getState().openSettings("providers", environmentId)
                  }
                >
                  Provider settings
                </Button>
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </>
          )}
          {step === "project" && (
            <div
              className={cn(
                "-mx-4 space-y-5 rounded-xl px-4 py-5",
                folderDrop.dragging && "outline-2 outline-dashed outline-ring",
              )}
            >
              <FolderOpenIcon className="size-9 text-muted-foreground" aria-hidden />
              <p className="text-sm text-muted-foreground">
                The project picker handles folders, Git repositories, and existing projects. Close
                it to return here; your setup progress stays in place.
              </p>
              {folderDropEnabled && (
                <p className="text-sm text-muted-foreground">
                  {folderDrop.dragging ? "Drop a folder to add it." : "Or drop a folder here."}
                </p>
              )}
              {folderDrop.error && (
                <p role="alert" className="text-sm text-destructive">
                  {folderDrop.error}
                </p>
              )}
              {projectCount > 0 && (
                <p role="status" className="flex items-center gap-2 text-sm">
                  <CheckIcon aria-hidden className="size-4" />
                  {projectCount === 1
                    ? "Your project is ready."
                    : `${projectCount} projects are ready.`}
                </p>
              )}
              <Button
                disabled={!ready || !projectCapability.allowed}
                onClick={() => useCommandPaletteStore.getState().openAddProject()}
              >
                Add project
              </Button>
              <Button
                variant="outline"
                disabled={!ready}
                onPointerEnter={preloadProjectImportDialog}
                onFocus={preloadProjectImportDialog}
                onClick={() => openProjectImportDialog({ environmentId })}
              >
                Import from Codex or Claude Code
              </Button>
            </div>
          )}
          {step === "tour" && (
            <ol className="divide-y">
              {tourItems(window.desktopBridge !== undefined).map(
                ({ icon: Icon, title, text, actions }) => (
                  <li key={title} className="flex gap-4 py-5">
                    <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div>
                      <h3 className="text-sm font-medium">{title}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">{text}</p>
                      {actions && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {actions.map((action) => (
                            <Button
                              key={action.label}
                              size="xs"
                              variant="outline"
                              disabled={!ready}
                              onClick={() => revealConnectionsSetting(action.reveal)}
                            >
                              {action.label}
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                ),
              )}
            </ol>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" className="sm:mr-auto" onClick={() => onComplete("skipped")}>
            Skip setup
          </Button>
          {stepIndex > 0 && (
            <Button variant="outline" onClick={() => setStep(ONBOARDING_STEPS[stepIndex - 1]!)}>
              Back
            </Button>
          )}
          <Button
            onClick={() =>
              step === "tour" ? onComplete("completed") : setStep(ONBOARDING_STEPS[stepIndex + 1]!)
            }
          >
            {step === "tour" ? "Finish setup" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
