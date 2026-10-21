import { resolveAutoSettleAfterDays } from "@ryco/shared/threadSettlement";
import { getWsConnectionStatusForEnvironment } from "@ryco/client-runtime/rpc";
import {
  applyAutoSettleRuleToNodes,
  describeAutoSettleRuleApplyResult,
} from "@ryco/client-runtime/state/settings";
import type { EnvironmentId, ProviderOptionSelectionValue } from "@ryco/contracts";
import {
  SIDEBAR_AUTO_SETTLE_DAY_OPTIONS,
  type AiFocusRefreshIntervalMs,
  type SidebarAutoSettleAfterDays,
} from "@ryco/contracts/settings";
import {
  AI_FOCUS_DISCLOSURE_FIELDS,
  AI_FOCUS_REFRESH_INTERVAL_OPTIONS,
  makeAiFocusModelOverridePatch,
  resolveAiFocusEnvironmentRows,
  type AiFocusEnvironmentRow,
} from "@ryco/shared/aiFocusSettings";
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ModelPickerSheet } from "../threads/ModelPickerSheet";
import {
  applyModelOption,
  buildModelPickerModel,
  resolveModelPickerSelection,
} from "../threads/modelPickerModel";
import { updateEnvironmentServerSettings } from "../../connection/environmentApi";
import { getCachedHubNodeRoster, subscribeCachedHubNodeRoster } from "../../hostedHub/nodeRoster";
import { useMobileHostedConnectionsStore } from "../../hostedHub/state";
import { useConnectionRegistry } from "../../providers/ConnectionRegistryProvider";
import { useWsConnectionOpenedCount } from "../../rpc/wsConnectionState";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { updatePreferences, usePreferences } from "../../state/preferencesStore";
import { refreshMobileThreadPrioritiesNow } from "../../threadPriorityRefreshRuntime";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSavedEnvironments } from "../connection/useConnectionController";
import {
  autoSettleRuleModelNote,
  buildAutoSettleRuleModel,
  buildAutoSettleRuleTargets,
  changeAutoSettleRuleModel,
} from "./autoSettleRuleModel";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

const AUTO_SETTLE_DETAIL =
  "Uses the last message or turn. Running work, queued messages, pending input, open pull requests, and tasks kept active are protected.";

function autoSettleLabel(value: SidebarAutoSettleAfterDays): string {
  return value === null ? "Off" : `After ${value} ${value === 1 ? "day" : "days"}`;
}

function modelLabel(row: AiFocusEnvironmentRow): string {
  const provider = row.effectiveProvider?.displayName ?? row.effectiveProvider?.driver;
  const model = row.effectiveModelSelection?.model;
  return [row.inherited ? "Text model" : "Separate", provider, model].filter(Boolean).join(" · ");
}

export function SettingsInboxRouteScreen() {
  const { driver } = useConnectionRegistry();
  const [connections, setConnections] = useState(() => driver.supervisor.list());
  const configs = useEnvironmentServerConfigs();
  const connectionOpenedCount = useWsConnectionOpenedCount();
  const preferences = usePreferences();
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pickerEnvironmentId, setPickerEnvironmentId] = useState<EnvironmentId | null>(null);
  const [query, setQuery] = useState("");
  const [ruleEnvironmentId, setRuleEnvironmentId] = useState<EnvironmentId | null>(null);
  const [ruleStatus, setRuleStatus] = useState<string | null>(null);
  const [ruleBusy, setRuleBusy] = useState(false);
  const { rows: savedRows } = useSavedEnvironments();
  const hostedNodes = useMobileHostedConnectionsStore((state) => state.selectedNodes);
  const rosterNodes = useSyncExternalStore(subscribeCachedHubNodeRoster, getCachedHubNodeRoster);

  useEffect(
    () =>
      driver.supervisor.subscribe(() => {
        setConnections(driver.supervisor.list());
      }),
    [driver],
  );

  const rows = useMemo(() => {
    void connectionOpenedCount;
    const connectionById = new Map(
      connections.map((connection) => [connection.environmentId, connection] as const),
    );
    return resolveAiFocusEnvironmentRows(
      [...configs].map(([environmentId, serverConfig]) => ({
        environmentId,
        label:
          connectionById.get(environmentId)?.knownEnvironment.label ??
          serverConfig.environment.label,
        connected:
          connectionById.has(environmentId) &&
          getWsConnectionStatusForEnvironment(environmentId).phase === "connected",
        serverConfig,
      })),
    );
  }, [configs, connectionOpenedCount, connections]);

  const selectedRow = rows.find((row) => row.environmentId === pickerEnvironmentId) ?? null;
  const pickerModel = buildModelPickerModel({
    serverConfig: selectedRow?.serverConfig,
    currentSelection: selectedRow?.effectiveModelSelection ?? null,
    query,
  });

  const persistModel = async (
    row: AiFocusEnvironmentRow,
    selection: typeof row.effectiveModelSelection,
  ) => {
    if (!row.serverConfig) return;
    try {
      await updateEnvironmentServerSettings(
        row.environmentId,
        makeAiFocusModelOverridePatch({ serverConfig: row.serverConfig, selection }),
      );
      setPickerEnvironmentId(null);
      setQuery("");
    } catch (error) {
      setRefreshStatus(`${row.label}: ${errorMessage(error)}`);
    }
  };

  const refreshNow = async () => {
    setRefreshing(true);
    setRefreshStatus(null);
    const result = await refreshMobileThreadPrioritiesNow();
    if (result.failures.length > 0) {
      setRefreshStatus(
        result.failures
          .map(({ environmentId, error }) => {
            const label = rows.find((row) => row.environmentId === environmentId)?.label;
            return `${label ?? "Environment"}: ${errorMessage(error)}`;
          })
          .join(" · "),
      );
    } else if (result.attempted.length === 0) {
      setRefreshStatus("No connected supported nodes. Nothing was awakened.");
    } else {
      setRefreshStatus(
        `Updated ${result.succeeded.length} environment${result.succeeded.length === 1 ? "" : "s"}.`,
      );
    }
    setRefreshing(false);
  };

  const deviceAutoSettleAfterDays = resolveAutoSettleAfterDays(
    preferences.sidebarAutoSettleAfterDays,
  );
  const intervalMs = preferences.aiFocusRefreshIntervalMs ?? 600_000;

  // Each node keeps its own auto-settle rule; settings write it to the node.
  const nodeLabels = useMemo(() => {
    const labels = new Map<EnvironmentId, string>();
    for (const node of rosterNodes) labels.set(node.environmentId, node.label);
    for (const row of savedRows) labels.set(row.record.environmentId, row.record.label);
    for (const node of hostedNodes) labels.set(node.environmentId, node.label);
    return labels;
  }, [hostedNodes, rosterNodes, savedRows]);
  const isNodeOwner = (environmentId: EnvironmentId) =>
    hostedNodes.find((node) => node.environmentId === environmentId)?.effectiveRole === "owner" ||
    savedRows.find((row) => row.record.environmentId === environmentId)?.runtime.role === "owner";
  const isNodeConnected = (environmentId: EnvironmentId) =>
    connections.some((connection) => connection.environmentId === environmentId) &&
    getWsConnectionStatusForEnvironment(environmentId).phase === "connected";
  const ruleModel = buildAutoSettleRuleModel({
    configs,
    labelOf: (environmentId, config) => nodeLabels.get(environmentId) ?? config.environment.label,
    isOwner: isNodeOwner,
    isConnected: isNodeConnected,
    selectedEnvironmentId: ruleEnvironmentId,
    deviceValue: deviceAutoSettleAfterDays,
  });
  const editingRuleNode = ruleModel.editing;

  const setAutoSettleRule = (value: SidebarAutoSettleAfterDays) => {
    setRuleStatus(null);
    // Only a write to the node waits; this device's own rule changes at once.
    const writesNode = editingRuleNode !== null;
    if (writesNode) setRuleBusy(true);
    void changeAutoSettleRuleModel(ruleModel, value, {
      writeNode: updateEnvironmentServerSettings,
      writeDevice: (sidebarAutoSettleAfterDays) =>
        updatePreferences({ sidebarAutoSettleAfterDays }),
    })
      .catch((error: unknown) =>
        setRuleStatus(`${editingRuleNode?.label ?? "Node"}: ${errorMessage(error)}`),
      )
      .finally(() => {
        if (writesNode) setRuleBusy(false);
      });
  };

  const applyRuleToAllNodes = () => {
    setRuleBusy(true);
    setRuleStatus(null);
    const targets = buildAutoSettleRuleTargets({
      environmentIds: [...nodeLabels.keys(), ...configs.keys()],
      configs,
      labelOf: (environmentId) =>
        nodeLabels.get(environmentId) ??
        configs.get(environmentId)?.environment.label ??
        environmentId,
      isOwner: isNodeOwner,
      isConnected: isNodeConnected,
      write: updateEnvironmentServerSettings,
    });
    void applyAutoSettleRuleToNodes(ruleModel.value, targets)
      .then((result) => setRuleStatus(describeAutoSettleRuleApplyResult(result)))
      .finally(() => setRuleBusy(false));
  };

  const ruleNote = autoSettleRuleModelNote(ruleModel);
  const autoSettleDetail =
    ruleNote === null ? AUTO_SETTLE_DETAIL : `${AUTO_SETTLE_DETAIL} ${ruleNote}`;
  const knownNodeCount = new Set<EnvironmentId>([...nodeLabels.keys(), ...configs.keys()]).size;
  const autoSettleOptionsDisabled =
    ruleBusy || (editingRuleNode !== null && !editingRuleNode.editable);

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
      >
        {ruleModel.nodes.length > 1 ? (
          <SettingsSection title="Auto-settle by node">
            {ruleModel.nodes.map((node, index) => (
              <SettingsRow
                key={node.environmentId}
                first={index === 0}
                label={node.label}
                detail={autoSettleLabel(node.value)}
                value={
                  node.environmentId === editingRuleNode?.environmentId ? "Editing" : undefined
                }
                onPress={() => {
                  setRuleStatus(null);
                  setRuleEnvironmentId(node.environmentId);
                }}
              />
            ))}
          </SettingsSection>
        ) : null}

        <SettingsSection title="Auto-settle inactive tasks">
          <SettingsRow
            first
            label="Off"
            detail={autoSettleDetail}
            value={ruleModel.value === null ? "Selected" : undefined}
            disabled={autoSettleOptionsDisabled}
            onPress={() => setAutoSettleRule(null)}
          />
          {SIDEBAR_AUTO_SETTLE_DAY_OPTIONS.map((days) => (
            <SettingsRow
              key={days}
              label={autoSettleLabel(days)}
              value={ruleModel.value === days ? "Selected" : undefined}
              disabled={autoSettleOptionsDisabled}
              onPress={() => setAutoSettleRule(days)}
            />
          ))}
          {knownNodeCount > 1 || ruleStatus !== null ? (
            <SettingsRow
              label="Apply to all connected nodes"
              detail={
                ruleStatus ?? "Gives every node this device can change the rule selected above."
              }
              value={ruleBusy ? "Applying…" : undefined}
              disabled={ruleBusy}
              onPress={applyRuleToAllNodes}
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title="AI Focus">
          <SettingsSwitchRow
            first
            label="Prioritize the Inbox"
            value={preferences.aiFocusEnabled ?? false}
            onValueChange={(aiFocusEnabled) => updatePreferences({ aiFocusEnabled })}
          />
          <SettingsRow
            label="Refresh now"
            detail={
              refreshStatus ??
              "Checks only nodes that are already connected. It never starts a connection."
            }
            value={refreshing ? "Refreshing…" : undefined}
            disabled={refreshing}
            onPress={() => void refreshNow()}
          />
        </SettingsSection>

        <SettingsSection title="Refresh interval">
          {AI_FOCUS_REFRESH_INTERVAL_OPTIONS.map((option, index) => (
            <SettingsRow
              key={option.value}
              first={index === 0}
              label={option.label}
              value={intervalMs === option.value ? "Selected" : undefined}
              onPress={() =>
                updatePreferences({
                  aiFocusRefreshIntervalMs: option.value as AiFocusRefreshIntervalMs,
                })
              }
            />
          ))}
        </SettingsSection>

        <SettingsSection title="Models">
          {rows.length === 0 ? (
            <SettingsRow first label="No environments available" detail="Connect a node first." />
          ) : (
            rows.map((row, index) => (
              <Fragment key={row.environmentId}>
                <SettingsRow
                  first={index === 0}
                  label={row.label}
                  value={row.supported ? modelLabel(row) : "Unsupported"}
                  detail={
                    !row.connected
                      ? "Offline — ranking waits for an existing connection."
                      : !row.supported
                        ? "Update this node to use AI ranking."
                        : row.inherited
                          ? "Inherits this node's text-generation model."
                          : "Uses a separate model for Inbox ranking."
                  }
                  disabled={!row.connected || !row.supported}
                  onPress={() => {
                    setPickerEnvironmentId(row.environmentId);
                    setQuery("");
                  }}
                />
                {!row.inherited && row.connected && row.supported ? (
                  <SettingsRow
                    label="Use text-generation model"
                    onPress={() => void persistModel(row, null)}
                  />
                ) : null}
              </Fragment>
            ))
          )}
        </SettingsSection>

        <View className="mx-5 mt-6 rounded-2xl border border-border bg-card px-5 py-4">
          <Text className="font-ryco-medium text-sm text-foreground">
            What the ranking model sees
          </Text>
          <Text className="mt-1 text-xs leading-5 text-foreground-muted">
            This metadata is sent only to the model configured on each node:
          </Text>
          {AI_FOCUS_DISCLOSURE_FIELDS.map((field) => (
            <Text key={field} className="mt-1 text-xs leading-5 text-foreground-muted">
              • {field}
            </Text>
          ))}
        </View>
      </ScrollView>

      <ModelPickerSheet
        visible={selectedRow !== null}
        model={pickerModel}
        query={query}
        onChangeQuery={setQuery}
        onClose={() => {
          setPickerEnvironmentId(null);
          setQuery("");
        }}
        onSelect={(key) => {
          if (!selectedRow) return;
          const selection = resolveModelPickerSelection(pickerModel, key);
          if (selection) void persistModel(selectedRow, selection);
        }}
        onSelectOption={(optionId, value) => {
          if (!selectedRow?.effectiveModelSelection) return;
          const selectedEntry = pickerModel.groups
            .flatMap((group) => group.entries)
            .find((entry) => entry.selected);
          if (!selectedEntry) return;
          void persistModel(
            selectedRow,
            applyModelOption(
              selectedRow.effectiveModelSelection,
              selectedEntry.capabilities,
              optionId,
              value as ProviderOptionSelectionValue,
            ),
          );
        }}
      />
    </>
  );
}
