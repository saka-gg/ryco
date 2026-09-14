import { resolveAutoSettleAfterDays } from "@ryco/shared/threadSettlement";
import { getWsConnectionStatusForEnvironment } from "@ryco/client-runtime/rpc";
import type { EnvironmentId, ProviderOptionSelectionValue } from "@ryco/contracts";
import {
  SIDEBAR_AUTO_SETTLE_DAY_OPTIONS,
  type AiFocusRefreshIntervalMs,
} from "@ryco/contracts/settings";
import {
  AI_FOCUS_DISCLOSURE_FIELDS,
  AI_FOCUS_REFRESH_INTERVAL_OPTIONS,
  makeAiFocusModelOverridePatch,
  resolveAiFocusEnvironmentRows,
  type AiFocusEnvironmentRow,
} from "@ryco/shared/aiFocusSettings";
import { Fragment, useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ModelPickerSheet } from "../threads/ModelPickerSheet";
import {
  applyModelOption,
  buildModelPickerModel,
  resolveModelPickerSelection,
} from "../threads/modelPickerModel";
import { updateEnvironmentServerSettings } from "../../connection/environmentApi";
import { useConnectionRegistry } from "../../providers/ConnectionRegistryProvider";
import { useWsConnectionOpenedCount } from "../../rpc/wsConnectionState";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { updatePreferences, usePreferences } from "../../state/preferencesStore";
import { refreshMobileThreadPrioritiesNow } from "../../threadPriorityRefreshRuntime";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
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

  const autoSettleAfterDays = resolveAutoSettleAfterDays(preferences.sidebarAutoSettleAfterDays);
  const intervalMs = preferences.aiFocusRefreshIntervalMs ?? 600_000;

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
      >
        <SettingsSection title="Auto-settle inactive tasks">
          <SettingsRow
            first
            label="Off"
            detail="Uses the last message or turn. Running work, queued messages, pending input, open pull requests, and tasks kept active are protected."
            value={autoSettleAfterDays === null ? "Selected" : undefined}
            onPress={() => updatePreferences({ sidebarAutoSettleAfterDays: null })}
          />
          {SIDEBAR_AUTO_SETTLE_DAY_OPTIONS.map((days) => (
            <SettingsRow
              key={days}
              label={`After ${days} ${days === 1 ? "day" : "days"}`}
              value={autoSettleAfterDays === days ? "Selected" : undefined}
              onPress={() => updatePreferences({ sidebarAutoSettleAfterDays: days })}
            />
          ))}
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
