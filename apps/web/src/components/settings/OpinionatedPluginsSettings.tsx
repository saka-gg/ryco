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
  OpinionatedPluginId,
  OpinionatedPluginStatus,
} from "@ryco/contracts";
import { DEFAULT_AGENT_TOKEN_MODE } from "@ryco/contracts";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { readEnvironmentApi } from "../../environmentApi";
import { ensureLocalApi } from "../../localApi";
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

function pluginStatusKey(status: OpinionatedPluginStatus): string {
  return `${status.pluginId}:${status.targetKind}:${status.providerInstanceId ?? "global"}`;
}

function statusLabel(status: OpinionatedPluginStatus): string {
  switch (status.state) {
    case "installed":
      return "Installed";
    case "not-installed":
      return "Not installed";
    case "unsupported":
      return "Unsupported";
    case "error":
      return "Error";
  }
}

function statusVariant(status: OpinionatedPluginStatus) {
  switch (status.state) {
    case "installed":
      return "success" as const;
    case "not-installed":
      return "outline" as const;
    case "unsupported":
      return "warning" as const;
    case "error":
      return "error" as const;
  }
}

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

function targetLabel(status: OpinionatedPluginStatus): string {
  if (status.targetKind === "global") {
    return "System";
  }
  return status.providerDisplayName ?? String(status.providerInstanceId ?? "Provider");
}

function impactLabel(plugin: OpinionatedPluginCatalogItem): string {
  return plugin.impact === "tool-output" ? "Tool output" : "Assistant output";
}

function scopeLabel(plugin: OpinionatedPluginCatalogItem): string {
  return plugin.scope === "global" ? "Global" : "Provider";
}

function pluginSortValue(pluginId: OpinionatedPluginId): number {
  switch (pluginId) {
    case "rtk":
      return 0;
    case "caveman":
      return 1;
    case "token-optimizer":
      return 2;
    case "token-savior":
      return 3;
    case "lean-ctx":
      return 4;
  }
}

function targetSortValue(status: OpinionatedPluginStatus): string {
  return `${status.targetKind === "global" ? "0" : "1"}:${targetLabel(status).toLowerCase()}`;
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
  const canInstall = status.canInstall && status.state !== "installed";
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex min-h-5 flex-wrap items-center gap-2">
          {statusIcon(status)}
          <span className="truncate text-[13px] font-medium text-foreground">
            {targetLabel(status)}
          </span>
          <Badge variant={statusVariant(status)} size="sm">
            {statusLabel(status)}
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

export function OpinionatedPluginsSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const settingsTarget = useSettingsTarget();
  const selectedTokenMode = settings.defaultAgentTokenMode ?? DEFAULT_AGENT_TOKEN_MODE;
  const selectedTokenModeOption = tokenModePresentation[selectedTokenMode];
  const SelectedTokenModeIcon = selectedTokenModeOption.icon;
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
        setPlugins(
          catalog.plugins.toSorted((a, b) => pluginSortValue(a.id) - pluginSortValue(b.id)),
        );
        setStatuses(statusResult.statuses);
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to load plugins",
            description: error instanceof Error ? error.message : "An error occurred.",
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

  const statusesByPlugin = useMemo(() => {
    const map = new Map<OpinionatedPluginId, OpinionatedPluginStatus[]>();
    for (const status of statuses) {
      const list = map.get(status.pluginId) ?? [];
      list.push(status);
      map.set(status.pluginId, list);
    }
    const sortedMap = new Map<OpinionatedPluginId, OpinionatedPluginStatus[]>();
    for (const [pluginId, list] of map) {
      sortedMap.set(
        pluginId,
        list.toSorted((a, b) => targetSortValue(a).localeCompare(targetSortValue(b))),
      );
    }
    return sortedMap;
  }, [statuses]);

  const openDocs = (plugin: OpinionatedPluginCatalogItem) => {
    const url = plugin.docsUrl ?? plugin.homepageUrl;
    void ensureLocalApi()
      .shell.openExternal(url)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to open plugin docs",
            description: error instanceof Error ? error.message : "An error occurred.",
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
    const label = targetLabel(status);
    void localApi.dialogs
      .confirm(
        `Install ${status.pluginId === "rtk" ? "RTK" : "Caveman"} for ${label}?\n\nThis may run networked CLI installation commands on this machine.`,
      )
      .then((confirmed) => {
        if (!confirmed) return;
        const key = pluginStatusKey(status);
        setInstallingKey(key);
        return server
          .installOpinionatedPlugin({
            pluginId: status.pluginId,
            ...(status.providerInstanceId ? { providerInstanceId: status.providerInstanceId } : {}),
          })
          .then((result) => {
            setStatuses((current) => {
              const next = current.filter((candidate) => pluginStatusKey(candidate) !== key);
              return [...next, result.status];
            });
            toastManager.add({
              type: "success",
              title: `${status.pluginId === "rtk" ? "RTK" : "Caveman"} installed`,
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
                description: error instanceof Error ? error.message : "An error occurred.",
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
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Token mode">
        <SettingsRow
          title="Default token mode"
          description="Applied to new threads and draft sessions. Existing threads keep their own mode."
          control={
            <Select
              value={selectedTokenMode}
              onValueChange={(value) =>
                updateSettings({
                  defaultAgentTokenMode: value as AgentTokenMode,
                })
              }
            >
              <SelectTrigger className="w-full sm:w-52" aria-label="Default token mode">
                <span className="inline-flex min-w-0 items-center gap-2">
                  <SelectedTokenModeIcon className="size-4 shrink-0 text-muted-foreground" />
                  <SelectValue>{selectedTokenModeOption.triggerLabel}</SelectValue>
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
          }
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
                    {impactLabel(plugin)}
                  </Badge>
                  <Badge variant="outline" size="sm">
                    {scopeLabel(plugin)}
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
                      key={pluginStatusKey(status)}
                      status={status}
                      isInstalling={installingKey === pluginStatusKey(status)}
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
