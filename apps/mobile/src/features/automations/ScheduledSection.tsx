import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { formatCount } from "@ryco/shared/String";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { scheduledPreview } from "./scheduledModel";
import { openSchedule, openScheduledList } from "./scheduledNavigation";
import { MissedRunsNotice, ScheduleListRow, WaitingRunRow } from "./ScheduledRows";
import { ScheduledQueueSync, useScheduledTasks } from "./useScheduledTasks";

/** Schedules previewed in the Tasks tab besides the runs waiting for approval. */
const PREVIEW_ROWS = 2;

/**
 * The Tasks tab's "Scheduled" section: runs waiting for approval (they expire in 15
 * minutes) and missed runs first, a short preview of the schedules, and a row to all of
 * them. Follows the tab's machine and project filter. Renders nothing until a machine can
 * have schedules.
 */
export function ScheduledSection(props: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly focused: boolean;
}) {
  const navigation = useNavigation();
  const { environmentId, projectId } = props;
  const { list, machines, nowMs } = useScheduledTasks({
    filter: { environmentId, projectId },
    active: props.focused,
  });
  const chevron = useThemeColor("--color-icon-subtle") as string;
  const icon = useThemeColor("--color-icon-muted") as string;
  if (machines.length === 0) return null;
  const preview = scheduledPreview(list, PREVIEW_ROWS);
  const total = list.rows.length;
  const showPlace = projectId === null;
  const openAll = () => openScheduledList(navigation, { environmentId, projectId });
  const allValue = !list.read
    ? ""
    : total === 0
      ? "None yet"
      : total > preview.length + list.waiting.length
        ? formatCount(total, "schedule")
        : "";
  return (
    <View className="gap-2 pt-2">
      {props.focused ? <ScheduledQueueSync machines={machines} /> : null}
      <View className="flex-row items-baseline justify-between px-5 pt-3">
        <Text
          accessibilityRole="header"
          className="text-[13px] font-ryco-bold uppercase tracking-wide text-foreground-muted"
        >
          Scheduled
        </Text>
        {list.waiting.length > 0 ? (
          <Text className="text-[13px] font-ryco-medium text-foreground">
            {formatCount(list.waiting.length, "waiting", "waiting")}
          </Text>
        ) : null}
      </View>
      {list.missed.map((missed) => (
        <View key={missed.environmentId} className="mx-4">
          <MissedRunsNotice missed={missed} nowMs={nowMs} showMachine={machines.length > 1} />
        </View>
      ))}
      <View className="mx-4 overflow-hidden rounded-2xl bg-card">
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
        {preview.map((row, index) => (
          <ScheduleListRow
            key={row.key}
            row={row}
            nowMs={nowMs}
            first={index === 0 && list.waiting.length === 0}
            showPlace={showPlace}
            onPress={() =>
              openSchedule(navigation, {
                environmentId: row.item.environmentId,
                projectId: row.item.projectId,
                automationId: row.item.row.id,
              })
            }
          />
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={total === 0 ? "Schedules. None yet. Open" : "All schedules"}
          onPress={openAll}
          className="flex-row items-center gap-3 pl-4 active:bg-subtle"
        >
          <View className="h-6 w-6 items-center justify-center">
            <SymbolView
              name={total === 0 ? "calendar.badge.plus" : "list.bullet"}
              size={17}
              tintColor={icon}
              type="monochrome"
            />
          </View>
          <View
            className={`min-h-[50px] flex-1 flex-row items-center gap-3 py-3 pr-4 ${
              list.waiting.length + preview.length > 0 ? "border-t border-border-subtle" : ""
            }`}
          >
            <Text className="flex-1 text-[16px] text-foreground">
              {total === 0 ? "Schedule a task" : "All schedules"}
            </Text>
            {allValue ? (
              <Text className="text-[14px] text-foreground-muted">{allValue}</Text>
            ) : null}
            <SymbolView name="chevron.right" size={13} weight="semibold" tintColor={chevron} />
          </View>
        </Pressable>
      </View>
    </View>
  );
}
