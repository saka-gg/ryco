import { MotionReveal } from "../../components/MotionReveal";
import { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from "react-native";
import type { StatRange } from "@ryco/client-runtime/usage";
import { AppText as Text } from "../../components/AppText";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { useStatisticsData, type StatisticsTab } from "./statistics/useStatisticsData";
import {
  Choice,
  Note,
  Panel,
  Tabs,
  Toggle,
  useStatisticsPalette,
} from "./statistics/StatisticsParts";
import { UsageStatistics } from "./statistics/UsageStatistics";
import { ActivityStatistics } from "./statistics/ActivityStatistics";
import { ProviderLimits } from "./statistics/ProviderLimits";

export function SettingsStatisticsRouteScreen() {
  const colors = useStatisticsPalette();
  const environments = useHomeEnvironments();
  const [tab, setTab] = useState<StatisticsTab>("usage");
  const [range, setRange] = useState<StatRange>("30d");
  const [device, setDevice] = useState("all");
  const selected =
    device === "all"
      ? environments.filter(
          (environment) =>
            environment.connectionState === "connected" ||
            environment.connectionState === "read-only",
        )
      : environments.filter((environment) => environment.environmentId === device);
  // Activity is scoped to one device, matching the desktop statistics snapshot.
  const activityDevice =
    selected.find((environment) => environment.connectionState === "connected") ?? selected[0];
  const scoped = tab === "activity" ? (activityDevice ? [activityDevice] : []) : selected;
  const data = useStatisticsData(scoped, tab, range);
  return (
    <ScrollView
      className="flex-1"
      style={{ backgroundColor: colors.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 16 }}
      refreshControl={<RefreshControl refreshing={data.refreshing} onRefresh={data.refresh} />}
    >
      <Note>Usage and work signals</Note>
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "usage", label: "Usage" },
          { value: "activity", label: "Activity" },
          { value: "limits", label: "Limits" },
        ]}
      />
      <View className="flex-row flex-wrap items-center gap-2">
        <Choice
          label="Device"
          value={device}
          onChange={setDevice}
          options={[
            {
              value: "all",
              label:
                tab === "activity"
                  ? (activityDevice?.label ?? "Select device")
                  : "Connected devices",
            },
            ...environments.map((environment) => ({
              value: environment.environmentId,
              label: environment.label,
            })),
          ]}
        />
        {tab !== "limits" ? (
          <Toggle
            label="Date range"
            value={range}
            onChange={(value) => setRange(value as StatRange)}
            options={[
              { value: "7d", label: "7D" },
              { value: "30d", label: "30D" },
              { value: "90d", label: "90D" },
              { value: "all", label: "All" },
            ]}
          />
        ) : null}
        <Pressable
          accessibilityRole="button"
          onPress={data.refresh}
          disabled={data.loading}
          className="px-3 py-2"
        >
          <Text className="text-sm text-foreground-secondary">
            {data.loading ? "Refreshing…" : "Refresh"}
          </Text>
        </Pressable>
      </View>
      {data.loading ? <ActivityIndicator accessibilityLabel="Loading statistics" /> : null}
      {!scoped.length ? (
        <Panel title="No devices available">
          <Note>Connect a device to see its statistics and provider limits.</Note>
        </Panel>
      ) : null}
      {data.nodes
        .filter((node) => node.error)
        .map((node) => (
          <Panel key={node.environment.environmentId} title={node.environment.label}>
            <Note>{node.error}</Note>
          </Panel>
        ))}
      {tab === "usage" && data.usage ? (
        <MotionReveal key="usage">
          <UsageStatistics summary={data.usage} />
        </MotionReveal>
      ) : null}
      {tab === "activity"
        ? data.nodes.map((node) =>
            node.activity ? (
              <MotionReveal key={node.environment.environmentId}>
                <ActivityStatistics
                  key={node.environment.environmentId}
                  snapshot={node.activity}
                  range={range}
                />
              </MotionReveal>
            ) : null,
          )
        : null}
      {tab === "limits"
        ? data.nodes.map((node) =>
            node.providers ? (
              <View key={node.environment.environmentId} className="gap-3">
                <Text className="text-lg font-ryco-bold text-foreground">
                  {node.environment.label}
                </Text>
                <MotionReveal>
                  <ProviderLimits
                    providers={node.providers}
                    connected={
                      node.environment.connectionState === "connected" ||
                      node.environment.connectionState === "read-only"
                    }
                  />
                </MotionReveal>
              </View>
            ) : null,
          )
        : null}
    </ScrollView>
  );
}
