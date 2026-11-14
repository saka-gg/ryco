import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LoaderIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentTokenMode,
  OpinionatedPluginCatalogItem,
  OpinionatedPluginStatus,
} from "@ryco/contracts";
import { DEFAULT_AGENT_TOKEN_MODE } from "@ryco/contracts";
import {
  canInstallOpinionatedPlugin,
  groupOpinionatedPluginStatuses,
  opinionatedPluginImpactLabel,
  opinionatedPluginName,
  opinionatedPluginScopeLabel,
  opinionatedPluginStatus,
  opinionatedPluginStatusKey,
  opinionatedPluginTargetLabel,
  replaceOpinionatedPluginStatus,
  sortOpinionatedPlugins,
} from "@ryco/client-runtime/state/settings/opinionatedPlugins";

import { readEnvironmentApi } from "../../environmentApi";
import { ensureLocalApi } from "../../localApi";
import {
  SharedSettingRow,
  sharedControlLabel,
  type SharedSettingControl,
} from "./sharedSettings/SharedSettingRow";
import { useSettingsTarget } from "../../settingsTarget";
import { tokenModeOptions, tokenModePresentation } from "../../tokenModePresentation";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsBlock,
} from "./settingsLayout";
import { errorMessage } from "~/lib/errorMessage";

function statusIcon(status: OpinionatedPluginStatus) {
  switch (status.state) {
    case "installed":
      return <CheckCircle2Icon className="size-3.5 text-success-foreground" />;
    case "not-installed":
      return <CircleDashedIcon className="size-3.5 text-muted-foreground" />;
    case "unsupported":
    case "error":
      return <CircleAlertIcon className="size-3.5 text-warning-foreground" />;
  }
}

function PluginTargetRow({
  status,
  isInstalling,
  onInstall,
}: {
  status: OpinionatedPluginStatus;
  isInstalling: boolean;
  onInstall: (status: OpinionatedPluginStatus) => void;
}) {
  const canInstall = canInstallOpinionatedPlugin(status);
  const presentation = opinionatedPluginStatus(status);
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex min-h-5 flex-wrap items-center gap-2">
          {statusIcon(status)}
          <span className="truncate text-[13px] font-medium text-foreground">
            {opinionatedPluginTargetLabel(status)}
          </span>
          <Badge variant={presentation.tone} size="sm">
            {presentation.label}
          </Badge>
          {status.version ? (
            <span className="font-mono text-[11px] text-muted-foreground/70">{status.version}</span>
          ) : null}
        </div>
        {status.detail ? (
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground/80">
            {status.detail}
          </p>
        ) : null}
        {status.manualSteps.length > 0 ? (
          <div className="space-y-1 pt-1">
            {status.manualSteps.map((step) => (
              <p
                key={step}
                className="break-words font-mono text-[11px] leading-relaxed text-muted-foreground"
              >
                {step}
              </p>
            ))}
          </div>
        ) : null}
      </div>
      {canInstall ? (
        <Button
          size="xs"
          variant="outline"
          disabled={isInstalling}
          className="self-start sm:self-auto"
          onClick={() => onInstall(status)}
        >
          {isInstalling ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <DownloadIcon className="size-3.5" />
          )}
          Install
        </Button>
      ) : null}
    </div>
  );
}

function TokenModeSelect({
  control,
}: {
  readonly control: SharedSettingControl<"defaultAgentTokenMode">;
}) {
  const selected = tokenModePresentation[control.value ?? DEFAULT_AGENT_TOKEN_MODE];
  const SelectedIcon = selected.icon;
  return (
    <Select
      value={control.value ?? DEFAULT_AGENT_TOKEN_MODE}
      disabled={control.disabled}
      onValueChange={(value) => control.onChange(value as AgentTokenMode)}
    >
      <SelectTrigger
        size="sm"
        className="w-full sm:w-52"
        aria-label={sharedControlLabel("Default token mode", control)}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <SelectedIcon className="size-4 shrink-0 text-muted-foreground" />
          <SelectValue>{selected.triggerLabel}</SelectValue>
        </span>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false} className="w-60">
        {tokenModeOptions.map((mode) => {
          const option = tokenModePresentation[mode];
          const OptionIcon = option.icon;
          return (
            <SelectItem key={mode} hideIndicator value={mode}>
              <div className="grid min-w-0 gap-0.5">
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  {option.label}
                </span>
                <span className="text-muted-foreground text-xs leading-4">
                  {option.description}
                </span>
              </div>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
}

export function OpinionatedPluginsSettingsPanel() {
  const settingsTarget = useSettingsTarget();
  const [plugins, setPlugins] = useState<ReadonlyArray<OpinionatedPluginCatalogItem>>([]);
  const [statuses, setStatuses] = useState<ReadonlyArray<OpinionatedPluginStatus>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const loadPlugins = useCallback(() => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setIsLoading(true);
    const server = settingsTarget
      ? readEnvironmentApi(settingsTarget.environmentId)?.server
      : ensureLocalApi().server;
    if (!server) {
      setIsLoading(false);
      loadingRef.current = false;
      return;
    }
    void Promise.all([server.listOpinionatedPlugins(), server.checkOpinionatedPlugins()])
      .then(([catalog, statusResult]) => {
        setPlugins(sortOpinionatedPlugins(catalog.plugins));
        setStatuses(statusResult.statuses);
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to load plugins",
            description: errorMessage(error, "An error occurred."),
          }),
        );
      })
      .finally(() => {
        loadingRef.current = false;
        setIsLoading(false);
      });
  }, [settingsTarget]);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  const statusesByPlugin = useMemo(() => groupOpinionatedPluginStatuses(statuses), [statuses]);

  const openDocs = (plugin: OpinionatedPluginCatalogItem) => {
    const url = plugin.docsUrl ?? plugin.homepageUrl;
    void ensureLocalApi()
      .shell.openExternal(url)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to open plugin docs",
            description: errorMessage(error, "An error occurred."),
          }),
        );
      });
  };

  const install = (status: OpinionatedPluginStatus) => {
    const localApi = ensureLocalApi();
    const server = settingsTarget
      ? readEnvironmentApi(settingsTarget.environmentId)?.server
      : localApi.server;
    if (!server) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Plugin install unavailable",
          description: `Node ${settingsTarget?.nodeLabel ?? "server"} is not connected.`,
        }),
      );
      return;
    }
    const label = opinionatedPluginTargetLabel(status);
    const pluginName = opinionatedPluginName(plugins, status.pluginId);
    void localApi.dialogs
      .confirm(
        `Install ${pluginName} for ${label}?\n\nThis may run networked CLI installation commands on this machine.`,
      )
      .then((confirmed) => {
        if (!confirmed) return;
        const key = opinionatedPluginStatusKey(status);
        setInstallingKey(key);
        return server
          .installOpinionatedPlugin({
            pluginId: status.pluginId,
            ...(status.providerInstanceId ? { providerInstanceId: status.providerInstanceId } : {}),
          })
          .then((result) => {
            setStatuses((current) => replaceOpinionatedPluginStatus(current, result.status));
            toastManager.add({
              type: "success",
              title: `${pluginName} installed`,
              description:
                result.commands.length > 0 ? result.commands[result.commands.length - 1] : label,
            });
            loadPlugins();
          })
          .catch((error: unknown) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Plugin install failed",
                description: errorMessage(error, "An error occurred."),
              }),
            );
          })
          .finally(() => setInstallingKey(null));
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Install confirmation failed",
            description: errorMessage(error, "An error occurred."),
          }),
        );
      });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Token mode">
        <SharedSettingRow
          settingKey="defaultAgentTokenMode"
          description="Applied to new threads and draft sessions. Existing threads keep their own mode."
          render={(control) => <TokenModeSelect control={control} />}
        />
      </SettingsSection>

      <SettingsSection
        title="Opinionated plugins"
        headerAction={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  disabled={isLoading}
                  onClick={() => loadPlugins()}
                  aria-label="Refresh plugin status"
                >
                  {isLoading ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3" />
                  )}
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh plugin status</TooltipPopup>
          </Tooltip>
        }
      >
        {plugins.length === 0 && isLoading ? (
          <SettingsBlock className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderIcon className="size-3.5 animate-spin" />
            Loading plugin status
          </SettingsBlock>
        ) : null}

        {plugins.map((plugin) => {
          const pluginStatuses = statusesByPlugin.get(plugin.id) ?? [];
          const installedCount = pluginStatuses.filter(
            (status) => status.state === "installed",
          ).length;
          return (
            <SettingsRow
              key={plugin.id}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{plugin.name}</span>
                  <Badge variant={installedCount > 0 ? "success" : "outline"} size="sm">
                    {installedCount > 0 ? `${installedCount} installed` : "Available"}
                  </Badge>
                </span>
              }
              description={plugin.summary}
              status={
                <span className="flex flex-wrap gap-1.5">
                  <Badge variant="info" size="sm">
                    {opinionatedPluginImpactLabel(plugin)}
                  </Badge>
                  <Badge variant="outline" size="sm">
                    {opinionatedPluginScopeLabel(plugin)}
                  </Badge>
                </span>
              }
              control={
                <Button size="xs" variant="ghost" onClick={() => openDocs(plugin)}>
                  <ExternalLinkIcon className="size-3.5" />
                  Docs
                </Button>
              }
            >
              <div className="rounded-[min(var(--radius-lg),0.625rem)] bg-muted/40 px-3">
                {pluginStatuses.length === 0 ? (
                  <p className="py-3 text-xs text-muted-foreground">
                    No compatible provider instances detected.
                  </p>
                ) : (
                  pluginStatuses.map((status) => (
                    <PluginTargetRow
                      key={opinionatedPluginStatusKey(status)}
                      status={status}
                      isInstalling={installingKey === opinionatedPluginStatusKey(status)}
                      onInstall={install}
                    />
                  ))
                )}
              </div>
            </SettingsRow>
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
