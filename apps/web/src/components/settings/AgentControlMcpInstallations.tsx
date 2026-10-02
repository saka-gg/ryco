import {
  type AgentControlExternalClientKind,
  type AgentControlMcpInstallation,
  type McpProviderSupport,
  type McpWorkspace,
} from "@ryco/contracts";
import {
  applyMcpInstallationList,
  applyMcpInstallationMutation,
  emptyMcpInstallationSettingsState,
} from "@ryco/client-runtime/state/settings";
import {
  BotIcon,
  CableIcon,
  CheckCircle2Icon,
  LoaderIcon,
  RefreshCwIcon,
  UnplugIcon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { useSettingsTarget } from "../../settingsTarget";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingsBlock,
  SettingsEmpty,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  AgentControlIntegrationFormFields,
  createAgentControlIntegrationForm,
  parseAgentControlIntegrationForm,
  type AgentControlIntegrationForm,
} from "./IntegrationsSettings";
import { retryAgentControlStartup } from "./agentControlStartupRetry";
import { getDriverOption } from "./providerDriverMeta";

const EMPTY_PROVIDERS: readonly McpProviderSupport[] = [];
const EMPTY_WORKSPACES: readonly McpWorkspace[] = [];

function providerLabel(provider: McpProviderSupport): string {
  return (
    provider.displayName ??
    getDriverOption(provider.driver)?.label ??
    formatProviderDriverKindLabel(provider.driver)
  );
}

function workspaceLabel(workspace: McpWorkspace): string {
  return (
    workspace.providerDisplayName ??
    getDriverOption(workspace.driver)?.label ??
    formatProviderDriverKindLabel(workspace.driver)
  );
}

function clientKindFor(workspace: McpWorkspace): AgentControlExternalClientKind {
  if (workspace.driver === "codex") return "codex";
  if (workspace.driver === "claudeAgent") return "claude-code";
  return "generic-mcp";
}

function formFor(workspace: McpWorkspace): AgentControlIntegrationForm {
  return {
    ...createAgentControlIntegrationForm(),
    displayName: `${workspaceLabel(workspace)} Agent Control`,
    clientKind: clientKindFor(workspace),
  };
}

function latestInstallation(
  installations: ReadonlyArray<AgentControlMcpInstallation>,
  workspaceId: McpWorkspace["id"],
): AgentControlMcpInstallation | undefined {
  return installations
    .filter((entry) => entry.workspaceId === workspaceId)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function installationStatus(installation: AgentControlMcpInstallation | undefined): {
  readonly label: string;
  readonly variant: "success" | "warning" | "error" | "outline";
} {
  if (!installation) return { label: "Not connected", variant: "outline" };
  switch (installation.state) {
    case "connected":
      return { label: "Connected", variant: "success" };
    case "repair-needed":
      return { label: "Needs repair", variant: "error" };
    case "disconnected":
    case "revoked":
      return { label: "Disconnected", variant: "outline" };
    case "disconnecting":
      return { label: "Disconnecting", variant: "warning" };
    case "planned":
    case "credential-written":
    case "provider-written":
    case "verifying":
      return { label: "Connecting", variant: "warning" };
  }
}

function successToast(title: string, description?: string) {
  toastManager.add(stackedThreadToast({ type: "success", title, description }));
}

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The request failed.",
    }),
  );
}

export function AgentControlMcpInstallations() {
  const settingsTarget = useSettingsTarget();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = settingsTarget?.environmentId ?? primaryEnvironmentId;
  const [providers, setProviders] = useState(EMPTY_PROVIDERS);
  const [workspaces, setWorkspaces] = useState(EMPTY_WORKSPACES);
  const [installations, setInstallations] = useState(emptyMcpInstallationSettingsState);
  const [topology, setTopology] = useState<{
    available: boolean;
    reason: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [customizingId, setCustomizingId] = useState<string | null>(null);
  const [customForm, setCustomForm] = useState(createAgentControlIntegrationForm);

  const environmentApi = useMemo(
    () => (environmentId === null ? undefined : readEnvironmentApi(environmentId)),
    [environmentId],
  );
  const agentControlApi = environmentApi?.agentControl;
  const mcpApi = environmentApi?.mcp;

  const refresh = useCallback(async () => {
    if (!agentControlApi || !mcpApi) {
      setLoading(false);
      return;
    }
    try {
      const [workspaceResult, installationResult, integrationResult] =
        await retryAgentControlStartup(() =>
          Promise.all([
            mcpApi.listWorkspaces(),
            agentControlApi.listMcpInstallations(),
            agentControlApi.listIntegrations(),
          ]),
        );
      setProviders(workspaceResult.providers);
      setWorkspaces(workspaceResult.workspaces);
      setInstallations((current) => applyMcpInstallationList(current, installationResult));
      setTopology(integrationResult.topology);
    } catch (error) {
      failureToast("Failed to load Agent Control providers", error);
    } finally {
      setLoading(false);
    }
  }, [agentControlApi, mcpApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = async (workspace: McpWorkspace, customized: boolean) => {
    if (!agentControlApi) return;
    try {
      setBusyId(workspace.id);
      const input = customized
        ? (() => {
            const { clientKind: _clientKind, ...settings } =
              parseAgentControlIntegrationForm(customForm);
            return { workspaceId: workspace.id, ...settings };
          })()
        : { workspaceId: workspace.id };
      const result = await agentControlApi.connectMcpInstallation(input);
      setInstallations((current) => applyMcpInstallationMutation(current, result));
      setCustomizingId(null);
      successToast(
        `${workspaceLabel(workspace)} connected`,
        "The credential was stored locally and was not shown to the browser.",
      );
    } catch (error) {
      failureToast(`Failed to connect ${workspaceLabel(workspace)}`, error);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const repair = async (workspace: McpWorkspace, installation: AgentControlMcpInstallation) => {
    if (!agentControlApi) return;
    try {
      setBusyId(workspace.id);
      const result = await agentControlApi.repairMcpInstallation({
        installationId: installation.installationId,
      });
      setInstallations((current) => applyMcpInstallationMutation(current, result));
      successToast(`${workspaceLabel(workspace)} repaired`);
    } catch (error) {
      failureToast(`Failed to repair ${workspaceLabel(workspace)}`, error);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = async (workspace: McpWorkspace, installation: AgentControlMcpInstallation) => {
    if (!agentControlApi) return;
    if (!window.confirm(`Disconnect Agent Control from ${workspaceLabel(workspace)}?`)) return;
    try {
      setBusyId(workspace.id);
      const result = await agentControlApi.disconnectMcpInstallation({
        installationId: installation.installationId,
      });
      setInstallations((current) => applyMcpInstallationMutation(current, result));
      successToast(`${workspaceLabel(workspace)} disconnected`);
    } catch (error) {
      failureToast(`Failed to disconnect ${workspaceLabel(workspace)}`, error);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const installableWorkspaces = workspaces.filter(
    (workspace) => workspace.capabilities.externalAgentControl === "available",
  );

  return (
    <div data-testid="agent-control-mcp-installations" className="contents">
      <SettingsSection
        title="Automatic inside Ryco"
        description="Supported sessions started by Ryco receive Agent Control automatically. There is nothing to install in those provider profiles."
      >
        {loading ? (
          <SettingsBlock className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderIcon className="size-3.5 animate-spin" /> Loading providers…
          </SettingsBlock>
        ) : providers.length === 0 ? (
          <SettingsEmpty
            icon={<BotIcon />}
            title="No provider instances"
            description="No configured provider instances were found."
            className="py-8"
          />
        ) : (
          providers.map((provider) => {
            const driver = getDriverOption(provider.driver);
            const Icon = driver?.icon ?? BotIcon;
            const automatic =
              provider.enabled && provider.capabilities.automaticAgentControl === "available";
            return (
              <SettingsRow
                key={provider.instanceId}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{providerLabel(provider)}</span>
                    <span className="truncate font-mono text-[11px] font-normal text-muted-foreground/70">
                      {provider.instanceId}
                    </span>
                  </span>
                }
                description={
                  automatic
                    ? "Available in every new Ryco-managed session."
                    : provider.enabled
                      ? "This provider does not expose automatic Agent Control yet."
                      : "This provider instance is disabled."
                }
                control={
                  <Badge size="sm" variant={automatic ? "success" : "outline"}>
                    {automatic ? "Automatic" : provider.enabled ? "Unavailable" : "Disabled"}
                  </Badge>
                }
              />
            );
          })
        )}
      </SettingsSection>

      <SettingsSection
        title="Connect an installed provider"
        description="Ryco detects local provider profiles and writes their native MCP configuration. The default grants project listing and task request/read access, limited to 60 requests per minute and one active task. Every task still requires approval."
        headerAction={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Refresh Agent Control providers"
                  disabled={loading}
                  onClick={() => void refresh()}
                >
                  <RefreshCwIcon className={cn(loading && "animate-spin")} />
                </Button>
              }
            />
            <TooltipPopup>Refresh</TooltipPopup>
          </Tooltip>
        }
      >
        {topology && !topology.available ? (
          <SettingsBlock>
            <SettingsNotice tone="warning" title="Local installation is unavailable">
              {topology.reason ?? "Ryco could not prove a direct loopback-only topology."}
            </SettingsNotice>
          </SettingsBlock>
        ) : null}

        {!loading && (!agentControlApi || !mcpApi) ? (
          <SettingsEmpty
            icon={<CableIcon />}
            title="Not available here"
            description="This Ryco environment does not expose provider MCP installation yet."
            className="py-8"
          />
        ) : !loading && installableWorkspaces.length === 0 ? (
          <SettingsEmpty
            icon={<CableIcon />}
            title="No installable profiles"
            description="Configure a supported provider instance first, then refresh."
            className="py-8"
          />
        ) : (
          installableWorkspaces.map((workspace) => {
            const installation = latestInstallation(installations.installations, workspace.id);
            const status = installationStatus(installation);
            const connected = installation?.state === "connected";
            const repairNeeded = installation?.state === "repair-needed";
            const working = busyId === workspace.id;
            const customizable = customizingId === workspace.id;
            const driver = getDriverOption(workspace.driver);
            const Icon = driver?.icon ?? CableIcon;
            const hasDetails =
              Boolean(installation?.lastError) ||
              Boolean(installation?.preservedUserChanges) ||
              customizable;

            return (
              <SettingsRow
                key={workspace.id}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{workspaceLabel(workspace)}</span>
                    <Badge size="sm" variant={status.variant}>
                      {status.label}
                    </Badge>
                  </span>
                }
                description={
                  <>
                    <span
                      className="block truncate font-mono text-[11px]"
                      title={workspace.displayPath}
                    >
                      {workspace.displayPath}
                    </span>
                    <span className="block">
                      {workspace.providerInstances.length} configured provider
                      {workspace.providerInstances.length === 1 ? " instance" : " instances"}
                      {installation ? ` · MCP name ${installation.serverName}` : ""}
                    </span>
                  </>
                }
                control={
                  repairNeeded && installation ? (
                    <Button
                      size="xs"
                      disabled={working || topology?.available === false}
                      onClick={() => void repair(workspace, installation)}
                    >
                      {working ? <LoaderIcon className="animate-spin" /> : <WrenchIcon />}
                      Repair
                    </Button>
                  ) : connected && installation ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={working}
                      onClick={() => void disconnect(workspace, installation)}
                    >
                      {working ? <LoaderIcon className="animate-spin" /> : <UnplugIcon />}
                      Disconnect
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={working || topology?.available === false}
                        onClick={() => {
                          if (customizable) {
                            setCustomizingId(null);
                          } else {
                            setCustomForm(formFor(workspace));
                            setCustomizingId(workspace.id);
                          }
                        }}
                      >
                        {customizable ? "Close" : "Customize"}
                      </Button>
                      <Button
                        size="xs"
                        disabled={working || topology?.available === false}
                        onClick={() => void connect(workspace, false)}
                      >
                        {working ? <LoaderIcon className="animate-spin" /> : <CheckCircle2Icon />}
                        Connect
                      </Button>
                    </>
                  )
                }
              >
                {hasDetails ? (
                  <div className="flex flex-col gap-3">
                    {installation?.lastError ? (
                      <SettingsNotice tone="error">{installation.lastError}</SettingsNotice>
                    ) : null}
                    {installation?.preservedUserChanges ? (
                      <SettingsNotice tone="warning">
                        Ryco left this provider&apos;s MCP entry untouched because it had been
                        edited after installation.
                      </SettingsNotice>
                    ) : null}
                    {customizable ? (
                      <div className="settings-subsections-enter grid gap-4 rounded-[min(var(--radius-lg),0.625rem)] bg-muted/40 p-4">
                        <p className="text-xs text-muted-foreground">
                          Customize the credential scope and limits before Ryco installs it. The
                          provider profile is fixed to this detected workspace.
                        </p>
                        <AgentControlIntegrationFormFields
                          form={customForm}
                          onChange={setCustomForm}
                          clientLocked
                        />
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            disabled={working || topology?.available === false}
                            onClick={() => void connect(workspace, true)}
                          >
                            {working ? <LoaderIcon className="animate-spin" /> : <CableIcon />}
                            Connect with these permissions
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </SettingsRow>
            );
          })
        )}
      </SettingsSection>
    </div>
  );
}
