import { MenuView, type MenuAction } from "@react-native-menu/menu";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { useLayoutEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useThemeColor } from "../../lib/useThemeColor";
import { openSchedule, openScheduleEditor } from "./scheduledNavigation";
import { MissedRunsNotice, ScheduleListRow, WaitingRunRow } from "./ScheduledRows";
import { ScheduledQueueSync, useScheduledTasks, type ScheduledMachine } from "./useScheduledTasks";

type ScheduledRouteScreenProps = StaticScreenProps<{
  readonly environmentId?: string;
  readonly projectId?: string;
}>;

function NewScheduleButton(props: {
  readonly machines: ReadonlyArray<ScheduledMachine>;
  readonly filter: {
    readonly environmentId: EnvironmentId | null;
    readonly projectId: ProjectId | null;
  };
  readonly onNew: (environmentId: EnvironmentId, projectId: ProjectId) => void;
}) {
  const icon = useThemeColor("--color-icon") as string;
  const { environmentId, projectId } = props.filter;
  const button = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New schedule"
      hitSlop={8}
      onPress={environmentId && projectId ? () => props.onNew(environmentId, projectId) : undefined}
      className="h-9 w-9 items-center justify-center active:opacity-60"
    >
      <SymbolView name="plus" size={19} weight="semibold" tintColor={icon} />
    </Pressable>
  );
  if (environmentId && projectId) return button;
  // Pick the project the schedule belongs to (its machine runs it).
  const machines = props.machines.filter(
    (machine) => environmentId === null || machine.environmentId === environmentId,
  );
  const several = machines.length > 1;
  const actions: MenuAction[] = machines.flatMap((machine) =>
    several
      ? [
          {
            id: `m:${machine.environmentId}`,
            title: machine.label,
            subactions: machine.projects.map((project) => ({
              id: `${machine.environmentId}\u001f${project.id}`,
              title: project.name,
            })),
          },
        ]
      : machine.projects.map((project) => ({
          id: `${machine.environmentId}\u001f${project.id}`,
          title: project.name,
        })),
  );
  if (actions.length === 0) return null;
  return (
    <MenuView
      title="New schedule in"
      actions={actions}
      shouldOpenOnLongPress={false}
      onPressAction={({ nativeEvent }) => {
        const [machine, project] = nativeEvent.event.split("\u001f");
        if (machine && project) props.onNew(machine as EnvironmentId, project as ProjectId);
      }}
    >
      {button}
    </MenuView>
  );
}

/**
 * Every schedule the phone reaches (or the Tasks tab's machine or project), by project:
 * runs waiting for approval first, then each project's schedules, the ones that need a
 * decision first. Pull to read them again; "+" proposes a new one.
 */
export function ScheduledRouteScreen(props: ScheduledRouteScreenProps) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const params = props.route.params ?? {};
  const filter = useMemo(
    () => ({
      environmentId: (params.environmentId ?? null) as EnvironmentId | null,
      projectId: (params.projectId ?? null) as ProjectId | null,
    }),
    [params.environmentId, params.projectId],
  );
  const { list, machines, loading, nowMs, refresh } = useScheduledTasks({
    filter,
    active: focused,
  });
  const [refreshing, setRefreshing] = useState(false);
  const newSchedule = (environmentId: EnvironmentId, projectId: ProjectId) =>
    openScheduleEditor(navigation, { mode: "new", environmentId, projectId });

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <NewScheduleButton machines={machines} filter={filter} onNew={newSchedule} />
      ),
    });
  });

  const empty =
    machines.length === 0 ? (
      <EmptyState
        variant="plain"
        title="No machine for schedules"
        detail="Schedules run on your machines. Connect one you own with Agent Control turned on."
      />
    ) : !list.read && loading ? (
      <EmptyState variant="plain" title="Loading…" detail="" />
    ) : list.rows.length === 0 ? (
      <EmptyState
        variant="plain"
        title="No schedules yet"
        detail="A schedule starts an agent chat on its own: once, every few hours, or on chosen days. Each run asks for your approval unless you allow it to run without asking."
      />
    ) : null;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingTop: 8, paddingBottom: 48 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            refresh();
            setTimeout(() => setRefreshing(false), 600);
          }}
        />
      }
    >
      {focused ? <ScheduledQueueSync machines={machines} /> : null}
      {list.missed.map((missed) => (
        <View key={missed.environmentId} className="mx-4 mb-3">
          <MissedRunsNotice missed={missed} nowMs={nowMs} showMachine={machines.length > 1} />
        </View>
      ))}
      {list.waiting.length > 0 ? (
        <View className="mb-2 gap-2">
          <Text className="px-6 text-[13px] font-ryco-medium text-foreground-muted">
            Waiting for approval
          </Text>
          <View className="mx-4 overflow-hidden rounded-[22px] bg-card">
            {list.waiting.map((waiting, index) => (
              <WaitingRunRow
                key={waiting.key}
                waiting={waiting}
                nowMs={nowMs}
                first={index === 0}
                onOpen={() =>
                  openSchedule(navigation, {
                    environmentId: waiting.environmentId,
                    projectId: waiting.projectId,
                    automationId: waiting.row.id,
                  })
                }
              />
            ))}
          </View>
        </View>
      ) : null}
      {list.groups.map((group) => (
        <View key={group.key} className="mt-4 gap-2">
          <Text className="px-6 text-[13px] font-ryco-medium text-foreground-muted">
            {group.title}
          </Text>
          <View className="mx-4 overflow-hidden rounded-[22px] bg-card">
            {group.rows.map((row, index) => (
              <ScheduleListRow
                key={row.key}
                row={row}
                nowMs={nowMs}
                first={index === 0}
                onPress={() =>
                  openSchedule(navigation, {
                    environmentId: row.item.environmentId,
                    projectId: row.item.projectId,
                    automationId: row.item.row.id,
                  })
                }
              />
            ))}
          </View>
        </View>
      ))}
      {empty ? <View className="px-6 py-14">{empty}</View> : null}
      {list.unavailable > 0 && list.read ? (
        <Text className="px-6 pt-4 text-xs text-foreground-muted">
          {list.unavailable === 1
            ? "One project's schedules could not be read. Pull to try again."
            : `${list.unavailable} projects' schedules could not be read. Pull to try again.`}
        </Text>
      ) : null}
    </ScrollView>
  );
}
