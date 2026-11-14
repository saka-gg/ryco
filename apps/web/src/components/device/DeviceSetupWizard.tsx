// The three steps follow t3code's device setup (MIT); see THIRD_PARTY_NOTICES.md.
import {
  DEVICE_PLATFORM_LABELS,
  devicePlatformSummary,
} from "@ryco/client-runtime/state/device/picker";
import type {
  DeviceAvailability,
  DeviceListResult,
  DevicePlatform,
  DevicePlatformAvailability,
} from "@ryco/contracts";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { errorMessage } from "~/lib/errorMessage";

export interface DeviceSetupValues {
  readonly devicesEnabled: boolean;
  readonly agentDevicesEnabled: boolean;
}

/**
 * First-run setup in the device panel: consent to use simulators, each
 * platform's checks with Check again, and consent for agents. Nothing boots
 * or installs here; the checks only read what is installed.
 */
export function DeviceSetupWizard(props: {
  readonly values: DeviceSetupValues;
  /** False when this client may not change the node's settings. */
  readonly canManage: boolean;
  readonly list: () => Promise<DeviceListResult>;
  readonly update: (patch: Partial<DeviceSetupValues>) => void;
  /** Setup done or skipped: saved on the node. */
  readonly onComplete: () => void;
}) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [platforms, setPlatforms] = useState<readonly DevicePlatformAvailability[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checks = useRef(0);
  const { list } = props;

  const check = useCallback(() => {
    const run = ++checks.current;
    setChecking(true);
    setCheckError(null);
    return list()
      .then(
        (result) => {
          if (run !== checks.current) return;
          setPlatforms(
            result.platforms && result.platforms.length > 0
              ? result.platforms
              : // An older node answers for both platforms at once.
                [{ platform: "ios-simulator", availability: result.availability }],
          );
        },
        (error: unknown) => {
          if (run === checks.current)
            setCheckError(errorMessage(error, "The node did not answer."));
        },
      )
      .then(() => {
        if (run === checks.current) setChecking(false);
      });
  }, [list]);

  // The first visit to the checks reads them once; Check again reads them again.
  const requested = useRef(false);
  useEffect(() => {
    if (step !== 1 || requested.current) return;
    requested.current = true;
    void check();
  }, [check, step]);

  const { devicesEnabled, agentDevicesEnabled } = props.values;
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto p-6" data-device-setup>
      <div className="w-full max-w-md">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Set up simulators</p>
          <Button size="xs" variant="ghost" disabled={!props.canManage} onClick={props.onComplete}>
            Skip setup
          </Button>
        </div>
        <ol className="mt-3 flex gap-1.5" aria-label="Setup steps">
          {(["Use simulators", "Platform checks", "Agent access"] as const).map((label, index) => (
            <li
              key={label}
              aria-current={index === step ? "step" : undefined}
              className={cn(
                "flex-1 rounded-full py-0.5 text-center text-[10px]",
                index === step
                  ? "bg-primary text-primary-foreground"
                  : index < step
                    ? "bg-primary/15 text-foreground"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>
        {props.canManage ? null : (
          <p className="mt-3 text-xs text-muted-foreground">
            Only the node's owner can change these settings.
          </p>
        )}

        {step === 0 ? (
          <StepCard
            title="Use simulators"
            body="Run iOS Simulators and Android Emulators from Ryco: the device panel in chats, and the device tools agents use. Opening the panel starts nothing; a device boots only when you pick one."
            control={
              <Switch
                aria-label="Use simulators"
                checked={devicesEnabled}
                disabled={!props.canManage}
                onCheckedChange={(checked) => props.update({ devicesEnabled: Boolean(checked) })}
              />
            }
            footer={
              <Button size="sm" onClick={() => setStep(1)}>
                Continue
              </Button>
            }
          />
        ) : null}

        {step === 1 ? (
          <div className="mt-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              Each platform is checked on its own: fixing a missing one does not block the other.
            </p>
            {checkError ? (
              <p role="alert" className="text-xs text-destructive">
                {checkError}
              </p>
            ) : null}
            {platforms === null ? (
              <p role="status" className="text-xs text-muted-foreground">
                Checking this node…
              </p>
            ) : (
              platforms.map((entry) => (
                <PlatformStatus
                  key={entry.platform}
                  platform={entry.platform}
                  availability={entry.availability}
                />
              ))
            )}
            <div className="flex items-center justify-between pt-1">
              <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
                {checking ? "Checking…" : "Check again"}
              </Button>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setStep(0)}>
                  Back
                </Button>
                <Button size="sm" onClick={() => setStep(2)}>
                  Continue
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <StepCard
            title="Agent access"
            body="Give agents Ryco's device tools to read the screen, tap, type and launch apps on simulators. Applies to agent sessions started afterwards."
            control={
              <Switch
                aria-label="Agents can use simulators"
                checked={devicesEnabled && agentDevicesEnabled}
                disabled={!props.canManage || !devicesEnabled}
                onCheckedChange={(checked) =>
                  props.update({ agentDevicesEnabled: Boolean(checked) })
                }
              />
            }
            note={devicesEnabled ? undefined : "Off while Use simulators is off."}
            footer={
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button size="sm" disabled={!props.canManage} onClick={props.onComplete}>
                  Finish
                </Button>
              </div>
            }
          />
        ) : null}
      </div>
    </div>
  );
}

function StepCard(props: {
  readonly title: string;
  readonly body: string;
  readonly control: ReactNode;
  readonly note?: string | undefined;
  readonly footer: ReactNode;
}) {
  return (
    <div className="mt-4 rounded-lg border border-border/70 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{props.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{props.body}</p>
          {props.note ? <p className="mt-2 text-xs text-muted-foreground">{props.note}</p> : null}
        </div>
        <div className="pt-0.5">{props.control}</div>
      </div>
      <div className="mt-4 flex justify-end">{props.footer}</div>
    </div>
  );
}

/** One platform's answer: ready, limited, what is missing, or not on this OS. */
export function PlatformStatus(props: {
  readonly platform: DevicePlatform;
  readonly availability: DeviceAvailability;
}) {
  const { availability } = props;
  const label = DEVICE_PLATFORM_LABELS[props.platform];
  const { tone, summary } = devicePlatformSummary(availability);
  return (
    <div
      className="rounded-lg border border-border/70 p-3"
      data-platform-status={props.platform}
      data-platform-tone={tone}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            tone === "ready"
              ? "bg-emerald-500"
              : tone === "warn"
                ? "bg-amber-500"
                : "bg-muted-foreground/50",
          )}
        />
        <p className="shrink-0 text-xs font-medium whitespace-nowrap">{label}</p>
        <p className="min-w-0 truncate text-xs text-muted-foreground" title={summary}>
          {summary}
        </p>
      </div>
      {availability.kind === "setup-required" ? (
        <ul className="mt-2 space-y-1.5">
          {availability.steps
            .filter((step) => !(step.done && step.id === "build-device-helper"))
            .map((step) => (
              <li key={step.id} className="flex gap-2 text-xs">
                <span
                  aria-label={step.done ? "Done" : "To do"}
                  className={cn("w-3 shrink-0", step.done ? "text-emerald-600" : "text-amber-600")}
                >
                  {step.done ? "✓" : "•"}
                </span>
                <div className="min-w-0">
                  <p className={cn(step.done && "text-muted-foreground")}>{step.label}</p>
                  {step.detail && !step.done ? (
                    <p className="mt-0.5 font-mono text-[10px] break-words text-muted-foreground select-text">
                      {step.detail}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
