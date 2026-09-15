import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  FolderOpenIcon,
  MessageSquareIcon,
  SettingsIcon,
  GitBranchIcon,
} from "lucide-react";
import { WS_METHODS, type EnvironmentId, type ServerProvider } from "@ryco/contracts";
import { readEnvironmentApi } from "../../environmentApi";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { getWsConnectionStatusForEnvironment } from "../../rpc/wsConnectionState";
import { applyProvidersUpdated } from "../../rpc/serverState";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { getProviderSummary } from "../settings/providerStatus";
import { PROVIDER_CLIENT_DEFINITIONS } from "../settings/providerDriverMeta";
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
import { ONBOARDING_STEPS, type OnboardingOutcome, type OnboardingStep } from "./onboardingState";

const STEP_LABELS = { providers: "Providers", project: "Project", tour: "Quick tour" };
const PROVIDER_GUIDES: Readonly<Record<string, string>> = {
  codex: "https://github.com/saka-gg/ryco/blob/main/docs/providers/codex.md",
  claudeAgent: "https://github.com/saka-gg/ryco/blob/main/docs/providers/claude.md",
};

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
  const refreshCapability = useHostedRpcCapability(WS_METHODS.serverRefreshProviders);
  const settingsCapability = useHostedRpcCapability(WS_METHODS.serverUpdateSettings);
  const projectCapability = useHostedRpcCapability(WS_METHODS.projectsAdd);
  const stepIndex = ONBOARDING_STEPS.indexOf(step);

  useEffect(() => {
    generation.current += 1;
    refreshingRef.current = false;
    setRefreshing(false);
    setError(null);
    return () => {
      generation.current += 1;
    };
  }, [connectionGeneration, environmentId, ready]);

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
            WELCOME TO RYCO · {stepIndex + 1} OF 3
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
                  const definition = PROVIDER_CLIENT_DEFINITIONS.find(
                    (item) => item.value === provider.driver,
                  );
                  const name = provider.displayName ?? definition?.label ?? provider.driver;
                  const guide = PROVIDER_GUIDES[provider.driver];
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
                      {guide && (
                        <a
                          href={guide}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-xs underline underline-offset-4"
                        >
                          Setup guide<span className="sr-only"> for {name}</span>
                        </a>
                      )}
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
              <p className="text-sm text-muted-foreground">
                Install and sign in with your provider’s own CLI on this machine, then refresh. Use
                Provider settings for custom binary paths, separate accounts, or API keys.
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
            <div className="space-y-5 py-5">
              <FolderOpenIcon className="size-9 text-muted-foreground" aria-hidden />
              <p className="text-sm text-muted-foreground">
                The project picker handles folders, Git repositories, and existing projects. Close
                it to return here; your setup progress stays in place.
              </p>
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
            </div>
          )}
          {step === "tour" && (
            <ol className="divide-y">
              {[
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
              ].map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex gap-4 py-5">
                  <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <div>
                    <h3 className="text-sm font-medium">{title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{text}</p>
                  </div>
                </li>
              ))}
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
