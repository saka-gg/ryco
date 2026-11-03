import { isElectron, isHostedHubMode } from "../../env";
import { useSettingsTarget, useSettingsEditingScope } from "../../settingsTarget";
import { WS_METHODS, type ServerSettingsPatch, type UnifiedSettings } from "@ryco/contracts";

import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { hostedCapabilityCopy } from "../../hostedHub/switchTarget";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ChevronDownIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { preloadableLazy, useLazyComponentReady } from "../../lib/preloadableLazy";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AgentControlMcpInstallations } from "./AgentControlMcpInstallations";
import { ExternalIntegrationsSettings } from "./IntegrationsSettings";
import { SettingsSelect, type SettingsSelectOption } from "./SettingsSelect";
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
 * The section body for the settings page's code-split loader. On desktops that
 * offer Computer Use it resolves only once that subsection's chunk has loaded
 * too, so the section's first commit renders it instead of its loading state.
 * A failed subsection load still resolves: the subsection reports it itself.
 */
export async function loadIntegrationsSettingsPanel(): Promise<typeof IntegrationsSettingsPanel> {
  if (window.desktopBridge?.computerUse) await ComputerUseSettings.preload();
  return IntegrationsSettingsPanel;
}

export function IntegrationsSettingsPanel() {
  const scope = useSettingsEditingScope();
  const target = useSettingsTarget();
  const localDevice = isElectron && !isHostedHubMode() && target?.primary === true;
  const canUseNativeControls =
    Boolean(window.desktopBridge?.computerUse) && (scope !== "node" || localDevice);
  return (
    <SettingsPageContainer>
      {scope !== "client" && <NodeIntegrationsSettingsPanel />}
      {scope === "node" && target && !localDevice && (
        <SettingsSection
          title="Device permissions"
          description={`To enable screen recording, accessibility, or computer use on ${target.nodeLabel}, open Ryco on ${target.nodeLabel} and use Settings → Integrations. Operating system permissions must be approved on that device.`}
          bare
        >
          {null}
        </SettingsSection>
      )}
      {canUseNativeControls && <ComputerUseSection />}
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
  const { updateSettings } = useUpdateSettings();
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
        <SettingsRow
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
          control={
            <Switch
              checked={enabled}
              disabled={!settingsCapability.allowed}
              onCheckedChange={(checked) =>
                updateSettings(agentControlPatch({ enabled: Boolean(checked) }))
              }
              aria-label="Enable Agent Control"
            />
          }
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

/**
 * An Agent Control settings change carrying only the fields it changes. The node, and the
 * optimistic local copy, merge settings patches deeply, so a device with stale settings never
 * sends back an old `enabled` or limit; the hook's patch type is shallow, hence the cast.
 */
const agentControlPatch = (
  change: NonNullable<ServerSettingsPatch["agentControl"]>,
): Partial<UnifiedSettings> => ({ agentControl: change }) as unknown as Partial<UnifiedSettings>;

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

/** The person's opt-in limits on agents delegating to agents (`ryco_create_threads`). */
function DelegationLimitsSection({
  disabled,
  disabledReason,
}: {
  disabled: boolean;
  disabledReason: string | null | undefined;
}) {
  const limits = useSettings((settings) => settings.agentControl.delegation);
  const { updateSettings } = useUpdateSettings();
  const setLimits = (next: Partial<typeof limits>) =>
    updateSettings(agentControlPatch({ delegation: next }));
  const status =
    disabled && disabledReason ? (
      <span className="text-destructive-foreground">{disabledReason}</span>
    ) : undefined;
  return (
    <SettingsSection
      title="Delegation limits"
      description="Stop agents from delegating without end. A chat you start can hand work to tasks, and tasks can hand work on in turn. These limits apply to new requests; tasks already created keep running."
    >
      <SettingsRow
        title="How deep tasks can go"
        description="Levels of tasks below the chat that started them. A task at the last level gets no delegation tools."
        status={status}
        control={
          <SettingsSelect
            value={limitValue(limits.maxDepth)}
            disabled={disabled}
            ariaLabel="How deep tasks can go"
            options={withCurrent(DEPTH_OPTIONS, limits.maxDepth, (limit) => `${limit} levels`)}
            onValueChange={(value) => setLimits({ maxDepth: parseLimit(value) })}
          />
        }
      />
      <SettingsRow
        title="Tasks per chat"
        description="How many tasks one chat and everything it delegated may create in all, finished and archived ones included."
        control={
          <SettingsSelect
            value={limitValue(limits.maxTasksPerTree)}
            disabled={disabled}
            ariaLabel="Tasks per chat"
            options={withCurrent(TASK_OPTIONS, limits.maxTasksPerTree, (limit) => `${limit} tasks`)}
            onValueChange={(value) => setLimits({ maxTasksPerTree: parseLimit(value) })}
          />
        }
      />
    </SettingsSection>
  );
}
