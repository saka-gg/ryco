import { formatDuration, formatInteger } from "~/lib/statisticsFormat";

import type { DayPoint } from "../../settings/statistics/selectors";
import type { StatisticsSearch } from "../statisticsSearch";

export function activityValue(point: DayPoint, metric: StatisticsSearch["activityMetric"]): number {
  return metric === "turns"
    ? point.turns
    : metric === "activeMs"
      ? point.activeMs
      : point.filesChanged;
}

export function summarizeActivity(
  days: readonly DayPoint[],
  metric: StatisticsSearch["activityMetric"],
): { readonly activeDays: number; readonly currentStreak: number; readonly busiestLabel: string } {
  let activeDays = 0;
  let currentStreak = 0;
  let busiest: DayPoint | null = null;
  for (const day of days) {
    const value = activityValue(day, metric);
    if (value > 0) activeDays += 1;
    if (busiest === null || value > activityValue(busiest, metric)) busiest = day;
  }
  // Today counts once it has activity; until then the streak runs through yesterday.
  let index = days.length - 1;
  const today = days[index];
  if (today !== undefined && activityValue(today, metric) <= 0) index -= 1;
  for (; index >= 0; index -= 1) {
    const day = days[index];
    if (day === undefined || activityValue(day, metric) <= 0) break;
    currentStreak += 1;
  }
  if (busiest === null || activityValue(busiest, metric) <= 0) {
    return { activeDays, currentStreak, busiestLabel: "—" };
  }
  const value = activityValue(busiest, metric);
  const formattedValue = metric === "activeMs" ? formatDuration(value) : formatInteger(value);
  return {
    activeDays,
    currentStreak,
    busiestLabel: `${busiest.date.slice(5)} · ${formattedValue}`,
  };
}
