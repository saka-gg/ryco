import { isElectron, isHostedHubMode } from "../../env";
import { useSettingsTarget } from "../../settingsTarget";
import { WS_METHODS } from "@ryco/contracts";
import type { AgentControlSettings } from "@ryco/contracts/settings";

import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { hostedCapabilityCopy } from "../../hostedHub/switchTarget";
import { useSettings } from "../../hooks/useSettings";
import { ChevronDownIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { preloadableLazy, useLazyComponentReady } from "../../lib/preloadableLazy";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AgentControlMcpInstallations } from "./AgentControlMcpInstallations";
import { ExternalIntegrationsSettings } from "./IntegrationsSettings";
import { SettingsSelect, type SettingsSelectOption } from "./SettingsSelect";
import { SharedSettingRow, sharedControlLabel } from "./sharedSettings/SharedSettingRow";
import {
  SettingsBlock,
  SettingsCard,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

// Renders synchronously once loaded (a `React.lazy` boundary held its fallback
// for React's 300 ms Suspense reveal throttle). The section's own preload
// starts it on desktops that offer Computer Use.
const ComputerUseSettings = preloadableLazy(() =>
  import("./ComputerUseSettings").then((module) => module.ComputerUseSettings),
);

/**
 * The device page's Computer use, for the settings page's code-split loader.
 * On desktops that offer Computer Use it resolves only once that chunk has
 * loaded too, so the part's first commit renders it instead of its loading
 * state. A failed load still resolves: the part reports it itself.
 */
export async function loadDeviceComputerUseSettings(): Promise<typeof DeviceComputerUseSettings> {
  if (window.desktopBridge?.computerUse) await ComputerUseSettings.preload();
  return DeviceComputerUseSettings;
}

/**
 * A device's Computer use: this computer's native controls in the desktop app,
 * otherwise where they are. Operating system permissions are approved on the
 * device itself.
 */
export function DeviceComputerUseSettings() {
  const target = useSettingsTarget();
  const localDevice = isElectron && !isHostedHubMode() && target?.primary === true;
  if (localDevice && window.desktopBridge?.computerUse) return <ComputerUseSection />;
  const label = target?.nodeLabel ?? "this device";
  return (
    <SettingsSection
      title="Device permissions"
      description={
        localDevice || target?.primary
          ? `Computer use needs the Ryco desktop app on ${label}.`
          : `To enable screen recording, accessibility, or computer use on ${label}, open Ryco on ${label} and use Settings → ${label} → Computer use. Operating system permissions must be approved on that device.`
      }
      bare
    >
      {null}
    </SettingsSection>
  );
}

/** Agent Control on the device the page shows. */
export function AgentControlSettingsPanel() {
  return (
    <SettingsPageContainer>
      <NodeIntegrationsSettingsPanel />
    </SettingsPageContainer>
  );
}

function ComputerUseSection() {
  // Loading renders as an ordinary commit; a failed load mounts the section,
  // which reports the error.
  const ready = useLazyComponentReady(ComputerUseSettings, true);
  if (ready) return <ComputerUseSettings />;
  return (
    <SettingsSection title="Computer Use">
      <SettingsBlock className="text-xs text-muted-foreground">
        Loading device integrations…
      </SettingsBlock>
    </SettingsSection>
  );
}

function NodeIntegrationsSettingsPanel() {
  const enabled = useSettings((settings) => settings.agentControl.enabled);
  const target = useSettingsTarget();
  const settingsCapability = useHostedRpcCapability(
    WS_METHODS.serverUpdateSettings,
    target?.environmentId ?? null,
  );
  const settingsReason = hostedCapabilityCopy(settingsCapability, target?.nodeLabel);
  const [manualSetupOpen, setManualSetupOpen] = useState(false);

  return (
    <>
      <SettingsSection
        title="Agent Control"
        description="Private tools for every agent, including visual replies (inline HTML pages). Ryco sessions receive the tools automatically. Connect supported standalone provider profiles with one click. Routine private-session actions run directly; destructive and security-sensitive changes require approval."
      >
        <SharedSettingRow
          settingKey="agentControl"
          title="Enable Agent Control"
          description={
            enabled
              ? "New Ryco-managed sessions receive Agent Control without changing the provider's global MCP configuration."
              : "Agent Control is unavailable to Ryco sessions and external clients."
          }
          status={
            !settingsCapability.allowed && settingsReason ? (
              <span className="text-destructive-foreground">{settingsReason}</span>
            ) : undefined
          }
          compareBy={selectEnabled}
          formatValue={(value) => (value.enabled ? "On" : "Off")}
          render={(control) => (
            <Switch
              checked={control.value.enabled}
              disabled={!settingsCapability.allowed || control.disabled}
              onCheckedChange={(checked) =>
                control.onChange({ ...control.value, enabled: Boolean(checked) })
              }
              aria-label={sharedControlLabel("Enable Agent Control", control)}
            />
          )}
        />
      </SettingsSection>
      {enabled ? (
        <>
          <DelegationLimitsSection
            disabled={!settingsCapability.allowed}
            disabledReason={settingsReason}
          />
          <AgentControlMcpInstallations />
          <SettingsCard>
            <SettingsRow
              title={
                <span className="flex items-center gap-2">
                  <KeyRoundIcon className="size-3.5 text-muted-foreground" />
                  Advanced manual setup
                </span>
              }
              description="Create a revocable pairing for another MCP client or a profile Ryco cannot detect."
              control={
                <Button
                  size="xs"
                  variant="ghost"
                  aria-expanded={manualSetupOpen}
                  onClick={() => setManualSetupOpen((open) => !open)}
                >
                  {manualSetupOpen ? "Hide" : "Show"}
                  <ChevronDownIcon
                    className={cn(
                      "transition-transform duration-(--app-motion-duration-chip)",
                      manualSetupOpen && "rotate-180",
                    )}
                  />
                </Button>
              }
            />
          </SettingsCard>
          {manualSetupOpen ? (
            <div className="settings-panel-enter">
              <ExternalIntegrationsSettings />
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

// Each row compares only the part of Agent Control it edits.
const selectEnabled = (value: AgentControlSettings) => value.enabled;
const selectMaxDepth = (value: AgentControlSettings) => value.delegation.maxDepth;
const selectMaxTasks = (value: AgentControlSettings) => value.delegation.maxTasksPerTree;

const NO_LIMIT = "none";
const DEPTH_OPTIONS: ReadonlyArray<SettingsSelectOption<string>> = [
  { value: NO_LIMIT, label: "No limit" },
  { value: "1", label: "1 level: tasks can't delegate" },
  { value: "2", label: "2 levels" },
  { value: "3", label: "3 levels" },
  { value: "5", label: "5 levels" },
];
const TASK_OPTIONS: ReadonlyArray<SettingsSelectOption<string>> = [
  { value: NO_LIMIT, label: "No limit" },
  ...[10, 25, 50, 100, 250].map((count) => ({ value: String(count), label: `${count} tasks` })),
];

const limitValue = (limit: number | null) => (limit === null ? NO_LIMIT : String(limit));
const parseLimit = (value: string) => (value === NO_LIMIT ? null : Number.parseInt(value, 10));
/** A saved limit the list doesn't offer (set elsewhere) stays selectable as itself. */
const withCurrent = (
  options: ReadonlyArray<SettingsSelectOption<string>>,
  limit: number | null,
  label: (limit: number) => string,
) =>
  limit === null || options.some((option) => option.value === String(limit))
    ? options
    : [...options, { value: String(limit), label: label(limit) }];

/**
 * The person's opt-in limits on agents delegating to agents (`ryco_create_threads`). Part of
 * the shared Agent Control setting; each row compares and edits its own limit.
 */
function DelegationLimitsSection({
  disabled,
  disabledReason,
}: {
  disabled: boolean;
  disabledReason: string | null | undefined;
}) {
  const status =
    disabled && disabledReason ? (
      <span className="text-destructive-foreground">{disabledReason}</span>
    ) : undefined;
  return (
    <SettingsSection
      title="Delegation limits"
      description="Stop agents from delegating without end. A chat you start can hand work to tasks, and tasks can hand work on in turn. These limits apply to new requests; tasks already created keep running."
    >
      <SharedSettingRow
        settingKey="agentControl"
        title="How deep tasks can go"
        description="Levels of tasks below the chat that started them. A task at the last level gets no delegation tools."
        status={status}
        compareBy={selectMaxDepth}
        formatValue={(value) =>
          value.delegation.maxDepth === null ? "No limit" : `${value.delegation.maxDepth} levels`
        }
        render={(control) => (
          <SettingsSelect
            value={limitValue(control.value.delegation.maxDepth)}
            disabled={disabled || control.disabled}
            ariaLabel={sharedControlLabel("How deep tasks can go", control)}
            options={withCurrent(
              DEPTH_OPTIONS,
              control.value.delegation.maxDepth,
              (limit) => `${limit} levels`,
            )}
            onValueChange={(value) =>
              control.onChange({
                ...control.value,
                delegation: { ...control.value.delegation, maxDepth: parseLimit(value) as never },
              })
            }
          />
        )}
      />
      <SharedSettingRow
        settingKey="agentControl"
        title="Tasks per chat"
        description="How many tasks one chat and everything it delegated may create in all, finished and archived ones included."
        compareBy={selectMaxTasks}
        formatValue={(value) =>
          value.delegation.maxTasksPerTree === null
            ? "No limit"
            : `${value.delegation.maxTasksPerTree} tasks`
        }
        render={(control) => (
          <SettingsSelect
            value={limitValue(control.value.delegation.maxTasksPerTree)}
            disabled={disabled || control.disabled}
            ariaLabel={sharedControlLabel("Tasks per chat", control)}
            options={withCurrent(
              TASK_OPTIONS,
              control.value.delegation.maxTasksPerTree,
              (limit) => `${limit} tasks`,
            )}
            onValueChange={(value) =>
              control.onChange({
                ...control.value,
                delegation: {
                  ...control.value.delegation,
                  maxTasksPerTree: parseLimit(value) as never,
                },
              })
            }
          />
        )}
      />
    </SettingsSection>
  );
}
