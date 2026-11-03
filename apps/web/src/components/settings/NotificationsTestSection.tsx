import { useState } from "react";

import { useSettingsDialogStore } from "../../settingsDialogStore";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Sample notifications for previewing the toast design from Settings →
 * Diagnostics. Each preset mirrors a real notification archetype the app
 * produces (payload shape, actions, timeouts), so the preview exercises the
 * same rendering paths — none of them touch providers, git, or the network.
 */

const SAMPLE_SLOW_REQUESTS = [
  { method: "thread/snapshot", requestId: "req_9f2c81d4a6", startedAt: "12s ago" },
  { method: "git/status", requestId: "req_c07b3e51fd", startedAt: "9s ago" },
] as const;

/**
 * Mirrors the real update flow (`updateProviderUpdateToast`): the prompt toast
 * itself morphs into the loading and then the success state, rather than a
 * second toast stacking next to a stranded prompt.
 */
function runSampleProviderUpdate(promptToastId: ReturnType<typeof toastManager.add>) {
  toastManager.update(promptToastId, {
    type: "loading",
    title: "Updating Claude Code",
    description: "Running provider update command.",
    timeout: 0,
    // `update` is a shallow merge, so the prompt's "Update" action must be
    // cleared explicitly; the fresh `data` drops the "Settings" secondary.
    actionProps: undefined,
    data: { hideCopyButton: true },
  });
  window.setTimeout(() => {
    toastManager.update(promptToastId, {
      type: "success",
      title: "Provider updated",
      description: "New sessions will use the updated provider.",
      timeout: 0,
      data: { hideCopyButton: true, dismissAfterVisibleMs: 3_000 },
    });
  }, 1_800);
}

interface NotificationTestPreset {
  readonly value: string;
  readonly label: string;
  readonly fire: () => void;
}

const PRESETS: ReadonlyArray<NotificationTestPreset> = [
  {
    value: "provider-update",
    label: "Provider update available",
    fire: () => {
      // Same helper the real prompt goes through, so the preview inherits the
      // helper-owned stacked action layout instead of drifting from it.
      const promptToastId = toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Update Available: Claude Code v2.1.4",
          description: "Install the update now or review provider settings.",
          timeout: 0,
          actionProps: {
            children: "Update",
            onClick: () => runSampleProviderUpdate(promptToastId),
          },
          actionVariant: "default",
          data: {
            hideCopyButton: true,
            secondaryActionProps: {
              children: "Settings",
              onClick: () => useSettingsDialogStore.getState().openSettings("providers"),
            },
            secondaryActionVariant: "outline",
          },
        }),
      );
    },
  },
  {
    value: "pr-checks-passed",
    label: "PR checks passed",
    fire: () => {
      toastManager.add({
        type: "success",
        title: "Checks passed for PR #316",
        description: "Redesign the notification toasts · 3273af68e412",
        timeout: 6_000,
        actionProps: { children: "Open PR", onClick: () => undefined },
        data: { actionVariant: "outline" },
      });
    },
  },
  {
    value: "git-push",
    label: "Git push with follow-up action",
    fire: () => {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Pushed",
          description: "3 commits pushed to origin/feat/notifications-toasts.",
          timeout: 0,
          actionProps: { children: "Open PR", onClick: () => undefined },
          actionVariant: "outline",
          data: { dismissAfterVisibleMs: 10_000 },
        }),
      );
    },
  },
  {
    value: "git-failed",
    label: "Git action failed",
    fire: () => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Action failed",
          description:
            "remote: Permission to sak0a/ryco.git denied to deploy-bot.\nfatal: unable to access 'https://github.com/sak0a/ryco.git/': The requested URL returned error: 403",
          timeout: 0,
        }),
      );
    },
  },
  {
    value: "git-pull",
    label: "Git pull (loading → result)",
    fire: () => {
      void toastManager.promise(
        new Promise((resolve) => {
          window.setTimeout(resolve, 2_400);
        }),
        {
          loading: { title: "Pulling..." },
          success: { title: "Pulled", description: "Updated main from origin/main." },
          error: { title: "Pull failed", description: "Could not fast-forward." },
        },
      );
    },
  },
  {
    value: "slow-requests",
    label: "Slow requests (expandable)",
    fire: () => {
      toastManager.add({
        type: "warning",
        title: "Some requests are slow",
        description: "2 requests waiting longer than 5s.",
        timeout: 0,
        data: {
          expandableDescriptionTrigger: true,
          expandableLabels: { expand: "Show requests", collapse: "Hide requests" },
          expandableContent: (
            <ul className="flex flex-col gap-1.5">
              {SAMPLE_SLOW_REQUESTS.map((request) => (
                <li className="flex min-w-0 items-baseline gap-2" key={request.requestId}>
                  <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 font-mono text-[10px]">
                    {request.method}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                    {request.requestId}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {request.startedAt}
                  </span>
                </li>
              ))}
            </ul>
          ),
        },
      });
    },
  },
  {
    value: "reconnected",
    label: "Connection restored",
    fire: () => {
      toastManager.add({
        type: "success",
        title: "Reconnected to Ryco Server",
        description: `Connection restored at ${new Date().toLocaleTimeString()}.`,
        timeout: 0,
        data: { dismissAfterVisibleMs: 8_000, hideCopyButton: true },
      });
    },
  },
  {
    value: "long-error",
    label: "Error with long details",
    fire: () => {
      toastManager.add({
        type: "error",
        title: "Provider session crashed",
        description:
          "The provider session exited unexpectedly with code 137 while processing the turn. Last stderr output: FATAL ERROR: Reached heap limit — allocation failed, JavaScript heap out of memory. Restart the session or reduce the attached context, then try again.",
        timeout: 0,
      });
    },
  },
];

const STACK_SAMPLE_VALUES = ["pr-checks-passed", "provider-update", "git-failed"] as const;

function fireStackSample() {
  STACK_SAMPLE_VALUES.forEach((value, index) => {
    const preset = PRESETS.find((entry) => entry.value === value);
    if (!preset) return;
    window.setTimeout(() => preset.fire(), index * 350);
  });
}

export function NotificationsTestSection({
  title = "Notifications",
}: { readonly title?: string } = {}) {
  const [presetValue, setPresetValue] = useState<string>(PRESETS[0]?.value ?? "");
  const preset = PRESETS.find((entry) => entry.value === presetValue) ?? PRESETS[0];

  return (
    <SettingsSection title={title}>
      <SettingsRow
        title="Test notification"
        description="Preview the notification design with realistic samples. Nothing is sent or changed."
        control={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Select
              value={presetValue}
              onValueChange={(value) => {
                if (typeof value === "string") setPresetValue(value);
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Notification sample">
                <SelectValue>{preset?.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {PRESETS.map((entry) => (
                  <SelectItem hideIndicator key={entry.value} value={entry.value}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button aria-label="Show test notification" size="xs" onClick={() => preset?.fire()}>
              Show
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Notification stack"
        description="Fire a short burst to preview stacking, peeking, and hover expansion."
        control={
          <Button size="xs" variant="outline" onClick={fireStackSample}>
            Show stack
          </Button>
        }
      />
    </SettingsSection>
  );
}
