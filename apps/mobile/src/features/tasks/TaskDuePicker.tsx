import { dueAtDayStart, dueAtForDay, dueQuickPicks } from "@ryco/client-runtime/state/tasks";
import { dayStart } from "@ryco/shared/automationSchedule";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  CALENDAR_WEEKDAY_LETTERS,
  calendarMonth,
  shiftCalendarMonth,
} from "./taskDueCalendarModel";

/**
 * A task's due day: the quick picks (Today, Tomorrow, Next week, No date)
 * and a month to pick any other day from. Due dates are whole days.
 */
export function TaskDuePicker(props: {
  readonly dueAt: string | null;
  readonly nowMs: number;
  readonly onChange: (dueAt: string | null) => void;
}) {
  const selectedDay = dueAtDayStart(props.dueAt);
  const shown = new Date(selectedDay ?? props.nowMs);
  const [visible, setVisible] = useState({ year: shown.getFullYear(), month: shown.getMonth() });
  const month = calendarMonth(visible.year, visible.month);
  const today = dayStart(props.nowMs);
  const icon = useThemeColor("--color-icon") as string;
  const pick = (dueAt: string | null) => {
    void Haptics.selectionAsync();
    props.onChange(dueAt);
  };
  return (
    <View className="gap-3 px-4 pb-3 pt-1">
      <View className="flex-row flex-wrap gap-2">
        {dueQuickPicks(props.nowMs).map((quick) => {
          const selected = selectedDay === quick.dayMs;
          return (
            <Pressable
              key={quick.label}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => pick(dueAtForDay(quick.dayMs))}
              className={cn(
                "h-8 justify-center rounded-full px-3",
                selected ? "bg-primary" : "bg-subtle active:bg-subtle-strong",
              )}
            >
              <Text
                className={cn(
                  "text-[13px] font-ryco-medium",
                  selected ? "text-primary-foreground" : "text-foreground",
                )}
              >
                {quick.label}
              </Text>
            </Pressable>
          );
        })}
        {props.dueAt !== null ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => pick(null)}
            className="h-8 justify-center rounded-full bg-subtle px-3 active:bg-subtle-strong"
          >
            <Text className="text-[13px] font-ryco-medium text-danger-foreground">No date</Text>
          </Pressable>
        ) : null}
      </View>
      <View className="flex-row items-center">
        <Text className="flex-1 text-[15px] font-ryco-bold text-foreground">{month.title}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          hitSlop={8}
          onPress={() => setVisible(shiftCalendarMonth(visible.year, visible.month, -1))}
          className="h-8 w-8 items-center justify-center rounded-full active:bg-subtle"
        >
          <SymbolView name="chevron.left" size={14} tintColor={icon} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next month"
          hitSlop={8}
          onPress={() => setVisible(shiftCalendarMonth(visible.year, visible.month, 1))}
          className="h-8 w-8 items-center justify-center rounded-full active:bg-subtle"
        >
          <SymbolView name="chevron.right" size={14} tintColor={icon} />
        </Pressable>
      </View>
      <View className="gap-1">
        <View className="flex-row">
          {CALENDAR_WEEKDAY_LETTERS.map((letter, index) => (
            <Text
              key={index}
              className="flex-1 text-center text-[11px] font-ryco-medium text-foreground-tertiary"
            >
              {letter}
            </Text>
          ))}
        </View>
        {month.weeks.map((week) => (
          <View key={week[0]!.dayMs} className="flex-row">
            {week.map((day) => {
              const selected = day.dayMs === selectedDay;
              const isToday = day.dayMs === today;
              return (
                <Pressable
                  key={day.dayMs}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={new Date(day.dayMs).toDateString()}
                  onPress={() => pick(dueAtForDay(day.dayMs))}
                  className="h-10 flex-1 items-center justify-center"
                >
                  <View
                    className={cn(
                      "h-9 w-9 items-center justify-center rounded-full",
                      selected && "bg-primary",
                    )}
                  >
                    <Text
                      className={cn(
                        "text-[15px]",
                        selected
                          ? "font-ryco-bold text-primary-foreground"
                          : isToday
                            ? "font-ryco-bold text-accent"
                            : day.inMonth
                              ? "text-foreground"
                              : "text-foreground-tertiary",
                      )}
                    >
                      {day.day}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}
