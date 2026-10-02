import { isElectron, isHostedHubMode } from "../../env";
import { useSettingsTarget, useSettingsEditingScope } from "../../settingsTarget";
import { WS_METHODS } from "@ryco/contracts";

import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ChevronDownIcon, KeyRoundIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AgentControlMcpInstallations } from "./AgentControlMcpInstallations";
import { ExternalIntegrationsSettings } from "./IntegrationsSettings";
import {
  SettingsBlock,
  SettingsCard,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const ComputerUseSettings = lazy(() =>
  import("./ComputerUseSettings").then((module) => ({ default: module.ComputerUseSettings })),
);

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
      {canUseNativeControls && (
        <Suspense
          fallback={
            <SettingsSection title="Computer Use">
              <SettingsBlock className="text-xs text-muted-foreground">
                Loading device integrations…
              </SettingsBlock>
            </SettingsSection>
          }
        >
          <ComputerUseSettings />
        </Suspense>
      )}
    </SettingsPageContainer>
  );
}

function NodeIntegrationsSettingsPanel() {
  const enabled = useSettings((settings) => settings.agentControl.enabled);
  const { updateSettings } = useUpdateSettings();
  const settingsCapability = useHostedRpcCapability(WS_METHODS.serverUpdateSettings);
  const [manualSetupOpen, setManualSetupOpen] = useState(false);

  return (
    <>
      <SettingsSection
        title="Agent Control"
        description="Private tools for every agent. Ryco sessions receive the tools automatically. Connect supported standalone provider profiles with one click. Routine private-session actions run directly; destructive and security-sensitive changes require approval."
      >
        <SettingsRow
          title="Enable Agent Control"
          description={
            enabled
              ? "New Ryco-managed sessions receive Agent Control without changing the provider's global MCP configuration."
              : "Agent Control is unavailable to Ryco sessions and external clients."
          }
          status={
            !settingsCapability.allowed && settingsCapability.reason ? (
              <span className="text-destructive-foreground">{settingsCapability.reason}</span>
            ) : undefined
          }
          control={
            <Switch
              checked={enabled}
              disabled={!settingsCapability.allowed}
              onCheckedChange={(checked) =>
                updateSettings({ agentControl: { enabled: Boolean(checked) } })
              }
              aria-label="Enable Agent Control"
            />
          }
        />
      </SettingsSection>
      {enabled ? (
        <>
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
