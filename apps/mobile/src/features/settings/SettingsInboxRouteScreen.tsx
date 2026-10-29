import { resolveAutoSettleAfterDays } from "@ryco/shared/threadSettlement";
import {
  applyAutoSettleRuleToNodes,
  describeAutoSettleRuleApplyResult,
} from "@ryco/client-runtime/state/settings";
import type { EnvironmentId } from "@ryco/contracts";
import {
  SIDEBAR_AUTO_SETTLE_DAY_OPTIONS,
  type SidebarAutoSettleAfterDays,
} from "@ryco/contracts/settings";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ScrollView } from "react-native";

import { updateEnvironmentServerSettings } from "../../connection/environmentApi";
import { getCachedHubNodeRoster, subscribeCachedHubNodeRoster } from "../../hostedHub/nodeRoster";
import { useMobileHostedConnectionsStore } from "../../hostedHub/state";
import { useConnectionRegistry } from "../../providers/ConnectionRegistryProvider";
import { useWsConnectionStatusesForEnvironments } from "../../rpc/wsConnectionState";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { updatePreferences, usePreferences } from "../../state/preferencesStore";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { ThreadAlertSettings } from "./ThreadAlertSettings";
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

export function SettingsInboxRouteScreen() {
  const { driver } = useConnectionRegistry();
  const [connections, setConnections] = useState(() => driver.supervisor.list());
  const configs = useEnvironmentServerConfigs();
  const preferences = usePreferences();
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

  // Each connected environment's own socket, subscribed: a status read in render
  // is cached by React Compiler and never sees the socket reopen or drop. Only
  // environments with a live connection are listed, so any other reads as not
  // connected.
  const statuses = useWsConnectionStatusesForEnvironments(
    connections.map((connection) => connection.environmentId),
  );

  const deviceAutoSettleAfterDays = resolveAutoSettleAfterDays(
    preferences.sidebarAutoSettleAfterDays,
  );

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
    statuses.get(environmentId)?.phase === "connected";
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
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
    >
      <ThreadAlertSettings />

      {ruleModel.nodes.length > 1 ? (
        <SettingsSection title="Auto-settle by node">
          {ruleModel.nodes.map((node, index) => (
            <SettingsRow
              key={node.environmentId}
              first={index === 0}
              label={node.label}
              detail={autoSettleLabel(node.value)}
              value={node.environmentId === editingRuleNode?.environmentId ? "Editing" : undefined}
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
    </ScrollView>
  );
}
