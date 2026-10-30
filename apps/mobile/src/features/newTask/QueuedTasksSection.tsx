import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@ryco/contracts";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useStore } from "../../state/threadsRuntime";
import { buildWaitingTaskRows, useNewTaskLaunchStore } from "./newTaskLaunchStore";

/**
 * Home's list of tasks still on this device: written while their machine was
 * away, or not started. Each opens its thread screen, where it can be edited,
 * removed or retried.
 */
export function QueuedTasksSection(props: {
  readonly machines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}) {
  const navigation = useNavigation();
  const launches = useNewTaskLaunchStore((state) => state.launchesByKey);
  const rows = useMemo(
    () =>
      buildWaitingTaskRows({
        launches,
        machineLabel: (environmentId) =>
          props.machines.find((machine) => machine.environmentId === environmentId)?.label ?? null,
      }),
    [launches, props.machines],
  );
  if (rows.length === 0) return null;

  return (
    <View className="mx-4 mb-3 mt-3 rounded-2xl border border-border bg-card">
      <Text className="px-4 pb-2 pt-3 text-xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
        Waiting to start
      </Text>
      {rows.map((row, index) => (
        <Pressable
          key={row.key}
          accessibilityRole="button"
          accessibilityLabel={`${row.title}. ${row.detail}`}
          onPress={() => {
            useStore.getState().setActiveEnvironmentId(row.environmentId);
            navigation.navigate("Thread", {
              environmentId: row.environmentId,
              threadId: row.threadId,
            });
          }}
          className={`min-h-14 px-4 py-3 active:opacity-70 ${index > 0 ? "border-t border-border" : ""}`}
        >
          <Text className="text-sm font-ryco-bold text-foreground" numberOfLines={1}>
            {row.title}
          </Text>
          <Text
            className={`mt-0.5 font-sans text-xs ${row.failed ? "text-danger-foreground" : "text-foreground-muted"}`}
            numberOfLines={1}
          >
            {row.detail}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
