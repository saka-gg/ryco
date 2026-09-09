import { useSettingsEditingScope } from "../../settingsTarget";
import { WS_METHODS } from "@ryco/contracts";

import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ChevronRightIcon, KeyRoundIcon } from "lucide-react";
import { Switch } from "../ui/switch";
import { AgentControlMcpInstallations } from "./AgentControlMcpInstallations";
import { ExternalIntegrationsSettings } from "./IntegrationsSettings";
import { lazy, Suspense } from "react";

const ComputerUseSettings = lazy(() =>
  import("./ComputerUseSettings").then((module) => ({ default: module.ComputerUseSettings })),
);

export function IntegrationsSettingsPanel() {
  const scope = useSettingsEditingScope();
  return (
    <div className="flex-1 overflow-y-auto">
      {scope !== "client" && <NodeIntegrationsSettingsPanel />}
      {scope !== "node" && window.desktopBridge?.computerUse && (
        <Suspense fallback={<p className="p-6">Loading device integrations…</p>}>
          <ComputerUseSettings />
        </Suspense>
      )}
    </div>
  );
}

function NodeIntegrationsSettingsPanel() {
  const enabled = useSettings((settings) => settings.agentControl.enabled);
  const { updateSettings } = useUpdateSettings();
  const settingsCapability = useHostedRpcCapability(WS_METHODS.serverUpdateSettings);

  return (
    <div className="flex-1 overflow-y-auto">
      <section
        data-settings-section="Private Agent Control"
        className="scroll-mt-6 border-b bg-muted/10 p-6 sm:p-8"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Private Agent Control
            </div>
            <h2 className="mt-1 text-lg font-semibold tracking-[-0.01em]">
              Private tools for every agent
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground/80">
              Ryco sessions receive the tools automatically. Connect supported standalone provider
              profiles with one click. Every requested change still waits for explicit approval.
            </p>
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              {enabled
                ? "Enabled. New Ryco-managed sessions receive Agent Control without changing the provider's global MCP configuration."
                : "Disabled. Agent Control is unavailable to Ryco sessions and external clients."}
            </p>
            {!settingsCapability.allowed && settingsCapability.reason ? (
              <p className="mt-2 max-w-2xl text-xs leading-relaxed text-destructive">
                {settingsCapability.reason}
              </p>
            ) : null}
          </div>
          <Switch
            checked={enabled}
            disabled={!settingsCapability.allowed}
            onCheckedChange={(checked) =>
              updateSettings({ agentControl: { enabled: Boolean(checked) } })
            }
            aria-label="Enable Agent Control"
          />
        </div>
      </section>
      {enabled ? (
        <>
          <AgentControlMcpInstallations />
          <details className="group border-b bg-muted/5">
            <summary className="mx-auto flex w-full max-w-4xl cursor-pointer list-none items-center gap-3 px-6 py-5 sm:px-8 [&::-webkit-details-marker]:hidden">
              <span className="flex size-8 items-center justify-center rounded-lg border bg-background">
                <KeyRoundIcon className="size-4 text-muted-foreground" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">Advanced manual setup</span>
                <span className="block text-xs text-muted-foreground">
                  Create a revocable pairing for another MCP client or a profile Ryco cannot detect.
                </span>
              </span>
              <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
            </summary>
            <ExternalIntegrationsSettings />
          </details>
        </>
      ) : null}
    </div>
  );
}
