import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { EnvironmentId, type ModelSelection, type ServerConfig } from "@ryco/contracts";
import { getWsConnectionStatusForEnvironment } from "@ryco/client-runtime/rpc";
import {
  autoSettleRuleScopeNote,
  readNodeAutoSettleRule,
  type AutoSettleRuleNodeView,
} from "@ryco/client-runtime/state/settings";
import { createModelSelection } from "@ryco/shared/model";
import {
  DEFAULT_CLIENT_SETTINGS,
  SIDEBAR_AUTO_SETTLE_DAY_OPTIONS,
  type SidebarAutoSettleAfterDays,
} from "@ryco/contracts/settings";
import { ArchiveIcon, InfoIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { isHostedHubMode } from "../../env";
import {
  listEnvironmentConnections,
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  updateEnvironmentServerSettings,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import {
  getPrimaryKnownEnvironment,
  usePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import { useEnvironmentSettingsTarget } from "../../hooks/useEnvironmentSettingsTarget";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import {
  updateClientAutoSettleAfterDays,
  useSettings,
  useUpdateSettings,
} from "../../hooks/useSettings";
import { useHostedHubStore } from "../../hostedHub/state";
import {
  applyAutoSettleRuleToAllNodes,
  setAutoSettleRule,
  type AutoSettleRuleNode,
} from "../../nodeAutoSettlement";
import { useDesktopWorkspaceState } from "../../platform/desktopWorkspace";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useServerConfig } from "../../rpc/serverState";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  AI_FOCUS_DISCLOSURE_FIELDS,
  AI_FOCUS_REFRESH_INTERVAL_OPTIONS,
  makeAiFocusClientSettingsPatch,
  makeAiFocusModelOverridePatch,
  resolveAiFocusEnvironmentRows,
  type AiFocusEnvironmentRow,
} from "./AiFocusSettings.logic";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsBlock,
  SettingsEmpty,
} from "./settingsLayout";
import { refreshWebThreadPrioritiesNow } from "../../threadPriorityRefreshRuntime";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

const AUTO_SETTLE_DESCRIPTION =
  "Move inactive tasks to Settled after their last message or turn. Running work, queued messages, pending input, open pull requests, and tasks kept active are protected.";

export function AutoSettleSettingsSection(props: {
  /** The node the rule applies to; null shows this device's own rule. */
  readonly node: AutoSettleRuleNodeView | null;
  /** This device's own rule, for nodes that keep none. */
  readonly deviceValue: SidebarAutoSettleAfterDays;
  readonly onChange: (value: SidebarAutoSettleAfterDays) => void;
  readonly onApplyToAll?: (() => void) | undefined;
  readonly busy?: boolean | undefined;
  readonly status?: ReactNode;
}) {
  // The node's own rule when it keeps one; otherwise this device's applies.
  const ruleNode = props.node?.ownsRule ? props.node : null;
  const value = ruleNode ? ruleNode.value : props.deviceValue;
  const disabled = props.busy === true || (ruleNode !== null && !ruleNode.editable);
  const note =
    props.node === null
      ? null
      : autoSettleRuleScopeNote(
          ruleNode ? { node: ruleNode } : { deviceRuleNodeLabels: [props.node.label] },
        );
  return (
    <SettingsSection title="Housekeeping" icon={<ArchiveIcon className="size-3.5" />}>
      <SettingsRow
        title="Auto-settle inactive tasks"
        {...(props.node ? { scope: ruleNode ? ruleNode.label : "This device" } : {})}
        description={note ? `${AUTO_SETTLE_DESCRIPTION} ${note}` : AUTO_SETTLE_DESCRIPTION}
        status={props.status}
        control={
          <>
            <Select
              value={value?.toString() ?? "off"}
              disabled={disabled}
              onValueChange={(next) => {
                if (disabled) return;
                const parsed = next === "off" ? null : Number(next);
                if (
                  parsed === null ||
                  SIDEBAR_AUTO_SETTLE_DAY_OPTIONS.includes(
                    parsed as Exclude<SidebarAutoSettleAfterDays, null>,
                  )
                ) {
                  props.onChange(parsed as SidebarAutoSettleAfterDays);
                }
              }}
            >
              <SelectTrigger className="w-48" aria-label="Auto-settle inactive tasks">
                <SelectValue>
                  {value === null ? "Off" : `After ${value} ${value === 1 ? "day" : "days"}`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="off">
                  Off
                </SelectItem>
                {SIDEBAR_AUTO_SETTLE_DAY_OPTIONS.map((days) => (
                  <SelectItem key={days} hideIndicator value={String(days)}>
                    After {days} {days === 1 ? "day" : "days"}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {props.onApplyToAll ? (
              <Button
                size="xs"
                variant="outline"
                disabled={props.busy === true}
                onClick={props.onApplyToAll}
              >
                Apply to all connected nodes
              </Button>
            ) : null}
          </>
        }
      />
    </SettingsSection>
  );
}

/**
 * Every node this client knows: the primary, then the hosted session's nodes,
 * or the saved environments and the Desktop workspace's machines.
 */
function useAutoSettleRuleNodes(): ReadonlyArray<AutoSettleRuleNode> {
  const hosted = isHostedHubMode();
  const primary = usePrimaryEnvironmentDescriptor();
  const hostedNodes = useHostedHubStore((state) => state.nodes);
  const savedEnvironments = useSavedEnvironmentRegistryStore((state) => state.byId);
  const desktopWorkspace = useDesktopWorkspaceState();
  return useMemo(() => {
    const nodes = new Map<EnvironmentId, string>();
    if (primary) nodes.set(primary.environmentId, primary.label);
    if (hosted) {
      for (const node of hostedNodes) {
        if (node.revokedAt !== null || node.capabilities?.nativeClientRequired === true) continue;
        if (!nodes.has(node.environmentId)) nodes.set(node.environmentId, node.label);
      }
    } else {
      for (const entry of Object.values(savedEnvironments)) {
        if (entry.environmentId === desktopWorkspace.localEnvironmentId) continue;
        if (!nodes.has(entry.environmentId)) nodes.set(entry.environmentId, entry.label);
      }
      for (const machine of desktopWorkspace.machines) {
        if (machine.environmentId === desktopWorkspace.localEnvironmentId) continue;
        if (!nodes.has(machine.environmentId)) nodes.set(machine.environmentId, machine.label);
      }
    }
    return [...nodes].map(([environmentId, label]) => ({ environmentId, label }));
  }, [desktopWorkspace, hosted, hostedNodes, primary, savedEnvironments]);
}

/**
 * The auto-settle rule of the node the settings show (the settings target, or
 * the primary node), kept by that node so every device lists its tasks alike.
 * An older node leaves the rule to each device, so this device's own applies.
 */
function NodeAutoSettleSettings() {
  const target = useSettingsTarget();
  const primary = usePrimaryEnvironmentDescriptor();
  const { target: primaryTarget } = useEnvironmentSettingsTarget(
    target ? null : (primary?.environmentId ?? null),
  );
  const node = target ?? primaryTarget;
  const deviceValue = useSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const knownNodes = useAutoSettleRuleNodes();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // The web phone tier is frozen: it keeps its device-only control.
  const phone = usePresentationTier() === "phone";

  const config = node?.serverConfig ?? null;
  const nodeRule = readNodeAutoSettleRule(config);
  const view: AutoSettleRuleNodeView | null =
    node === null
      ? null
      : {
          label: node.nodeLabel,
          ownsRule: nodeRule !== undefined,
          value: nodeRule === undefined ? deviceValue : nodeRule,
          editable:
            node.connected &&
            node.canManage !== false &&
            node.canMutate !== false &&
            config !== null,
        };

  const change = (value: SidebarAutoSettleAfterDays) => {
    setStatus(null);
    // Only a write to the node waits; this device's own rule changes at once.
    const writesNode = view?.ownsRule === true;
    if (writesNode) setBusy(true);
    void setAutoSettleRule(
      node === null || view === null ? null : { ...view, environmentId: node.environmentId },
      value,
    )
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not update ${node?.nodeLabel ?? "the node"}`,
            description: errorMessage(error),
          }),
        );
      })
      .finally(() => {
        if (writesNode) setBusy(false);
      });
  };

  const applyToAll = () => {
    setBusy(true);
    setStatus(null);
    void applyAutoSettleRuleToAllNodes(view?.ownsRule ? view.value : deviceValue, knownNodes)
      .then(setStatus)
      .finally(() => setBusy(false));
  };

  if (phone) {
    return (
      <AutoSettleSettingsSection
        node={null}
        deviceValue={deviceValue}
        onChange={updateClientAutoSettleAfterDays}
      />
    );
  }
  return (
    <AutoSettleSettingsSection
      node={view}
      deviceValue={deviceValue}
      onChange={change}
      onApplyToAll={knownNodes.length > (view === null ? 0 : 1) ? applyToAll : undefined}
      busy={busy}
      status={status ? <span role="status">{status}</span> : null}
    />
  );
}

function useEnvironmentConnectionSnapshot() {
  const [connections, setConnections] = useState(() => listEnvironmentConnections());
  useEffect(
    () =>
      subscribeEnvironmentConnections(() => {
        setConnections(listEnvironmentConnections());
      }),
    [],
  );
  return connections;
}

function EnvironmentModelControl({ row }: { row: AiFocusEnvironmentRow }) {
  const [saving, setSaving] = useState(false);
  const serverConfig = row.serverConfig;
  if (!serverConfig || !row.effectiveModelSelection) return null;

  const unifiedSettings = { ...serverConfig.settings, ...DEFAULT_CLIENT_SETTINGS };
  const selection = row.effectiveModelSelection;
  const entries = sortProviderInstanceEntries(
    deriveProviderInstanceEntries(serverConfig.providers),
  );
  const optionsByInstance = getCustomModelOptionsByInstance(
    unifiedSettings,
    serverConfig.providers,
    selection.instanceId,
    selection.model,
  );

  const persist = async (next: ModelSelection | null) => {
    setSaving(true);
    try {
      const patch = makeAiFocusModelOverridePatch({ serverConfig, selection: next });
      await updateEnvironmentServerSettings(row.environmentId, patch);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not update ${row.label}`,
          description: errorMessage(error),
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        modelOptions={selection.options}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={optionsByInstance}
        compact
        disabled={saving || !row.connected}
        {...(!row.connected
          ? { disabledReason: "Connect this environment to change its model." }
          : {})}
        onInstanceModelChange={(instanceId, model, options) => {
          void persist(
            resolveAppModelSelectionState(
              {
                ...unifiedSettings,
                textGenerationModelSelection: createModelSelection(instanceId, model, options),
              },
              serverConfig.providers,
            ),
          );
        }}
      />
      {!row.inherited ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={saving || !row.connected}
          onClick={() => void persist(null)}
        >
          Use text model
        </Button>
      ) : null}
    </div>
  );
}

function EnvironmentRow({ row }: { row: AiFocusEnvironmentRow }) {
  const providerLabel = row.effectiveProvider?.displayName ?? row.effectiveProvider?.driver ?? null;
  const status = !row.connected
    ? "Offline — ranking waits for an existing connection."
    : !row.supported
      ? "This node version does not support AI Focus ranking. Other supported nodes still work."
      : row.inherited
        ? `Inherits the text-generation model${providerLabel ? ` (${providerLabel})` : ""}.`
        : "Uses a separate model for Inbox ranking.";

  return (
    <SettingsRow
      title={row.label}
      description={status}
      control={row.supported ? <EnvironmentModelControl row={row} /> : undefined}
    />
  );
}

export function AiFocusSettings() {
  const editingScope = useSettingsEditingScope();
  const target = useSettingsTarget();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const primaryConfig = useServerConfig();
  const primary = getPrimaryKnownEnvironment();
  const savedRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const connections = useEnvironmentConnectionSnapshot();
  const [refreshing, setRefreshing] = useState(false);

  const rows = useMemo(() => {
    if (editingScope === "node" && target)
      return resolveAiFocusEnvironmentRows([
        {
          environmentId: target.environmentId,
          label: target.nodeLabel,
          connected: target.connected && target.canManage !== false,
          serverConfig: target.serverConfig,
        },
      ]);
    const byId = new Map<EnvironmentId, { label: string; config: ServerConfig | null }>();
    if (primary?.environmentId) {
      byId.set(primary.environmentId, { label: primary.label, config: primaryConfig });
    }
    for (const connection of connections) {
      if (byId.has(connection.environmentId)) continue;
      const runtime = savedRuntimeById[connection.environmentId];
      byId.set(connection.environmentId, {
        label: runtime?.descriptor?.label ?? connection.knownEnvironment.label,
        config: runtime?.serverConfig ?? null,
      });
    }
    for (const [rawEnvironmentId, runtime] of Object.entries(savedRuntimeById)) {
      const environmentId = EnvironmentId.make(rawEnvironmentId);
      if (byId.has(environmentId)) continue;
      byId.set(environmentId, {
        label: runtime.descriptor?.label ?? "Saved environment",
        config: runtime.serverConfig,
      });
    }
    return resolveAiFocusEnvironmentRows(
      [...byId].map(([environmentId, value]) => ({
        environmentId,
        label: value.label,
        connected:
          readEnvironmentConnection(environmentId) !== null &&
          getWsConnectionStatusForEnvironment(environmentId).phase === "connected",
        serverConfig: value.config,
      })),
    );
  }, [
    editingScope,
    target,
    connections,
    primary?.environmentId,
    primary?.label,
    primaryConfig,
    savedRuntimeById,
  ]);

  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    const result = await refreshWebThreadPrioritiesNow();
    const failures = result.failures;
    if (failures.length > 0) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "AI Focus refresh failed",
          description: failures
            .map(({ environmentId, error }) => {
              const label = rows.find((row) => row.environmentId === environmentId)?.label;
              return `${label ?? "Environment"}: ${errorMessage(error)}`;
            })
            .join(" · "),
        }),
      );
    } else {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title:
            result.attempted.length > 0 ? "AI Focus refreshed" : "No connected supported nodes",
          description:
            result.attempted.length > 0
              ? `Updated ${result.succeeded.length} environment${result.succeeded.length === 1 ? "" : "s"}.`
              : "Connect a supported node to rank its Inbox.",
        }),
      );
    }
    setRefreshing(false);
  }, [rows]);

  return (
    <SettingsPageContainer>
      <NodeAutoSettleSettings />

      <SettingsSection owner="client" title="AI Focus" icon={<SparklesIcon className="size-3.5" />}>
        <SettingsRow
          title="Prioritize the Inbox"
          description="Create a Focus section from pinned, actionable, and model-ranked threads. Focused threads are removed from Active, never duplicated."
          control={
            <Switch
              aria-label="Enable AI Focus"
              checked={settings.aiFocusEnabled}
              onCheckedChange={(enabled) =>
                updateSettings(makeAiFocusClientSettingsPatch({ enabled }))
              }
            />
          }
        />
        <SettingsRow
          title="Refresh rankings"
          description="Automatic checks use only nodes that are already connected. Manual-only never starts a connection."
          control={
            <div className="flex items-center gap-2">
              <Select
                value={String(settings.aiFocusRefreshIntervalMs)}
                onValueChange={(value) => {
                  const refreshIntervalMs = Number(value);
                  updateSettings(makeAiFocusClientSettingsPatch({ refreshIntervalMs }));
                }}
              >
                <SelectTrigger className="w-48" aria-label="AI Focus refresh interval">
                  <SelectValue>
                    {AI_FOCUS_REFRESH_INTERVAL_OPTIONS.find(
                      (option) => option.value === settings.aiFocusRefreshIntervalMs,
                    )?.label ?? "Every 10 minutes"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {AI_FOCUS_REFRESH_INTERVAL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} hideIndicator value={String(option.value)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="Refresh AI Focus now"
                disabled={refreshing}
                onClick={() => void refreshNow()}
              >
                <RefreshCwIcon className={refreshing ? "size-4 animate-spin" : "size-4"} />
              </Button>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection owner="node" title="Models">
        {rows.length > 0 ? (
          rows.map((row) => <EnvironmentRow key={row.environmentId} row={row} />)
        ) : (
          <SettingsEmpty
            title="No environments available"
            description="Connect a device to configure its Inbox ranking model."
            className="py-8"
          />
        )}
      </SettingsSection>

      <SettingsSection
        owner="node"
        title="Data sent to the selected model"
        icon={<InfoIcon className="size-3.5" />}
      >
        <SettingsBlock>
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            Ranking sends only this bounded metadata from each environment. It does not send full
            chat history, file contents, or message responses.
          </p>
          <ul className="grid gap-x-6 gap-y-1.5 text-xs text-foreground sm:grid-cols-2">
            {AI_FOCUS_DISCLOSURE_FIELDS.map((field) => (
              <li key={field} className="flex items-baseline gap-2">
                <span
                  aria-hidden
                  className="size-1 shrink-0 translate-y-[-2px] rounded-full bg-muted-foreground/60"
                />
                <span>{field}</span>
              </li>
            ))}
          </ul>
        </SettingsBlock>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
