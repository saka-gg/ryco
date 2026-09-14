// @effect-diagnostics globalDate:off
import {
  USAGE_CONTRACT_VERSION,
  type UsageCalendarDate,
  type UsageSummaryRequest,
} from "@ryco/contracts";
type StatisticsRange = "7d" | "30d" | "90d" | "all";
const RANGE_DAYS: Readonly<Record<StatisticsRange, number | null>> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

function calendarDateInZone(timestampMs: number, timeZone: string): UsageCalendarDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestampMs)) as UsageCalendarDate;
}

export function usageRequestForRange(
  range: StatisticsRange,
  timeZone: string,
  nowMs = Date.now(),
): UsageSummaryRequest {
  const endDate = calendarDateInZone(nowMs, timeZone);
  const days = RANGE_DAYS[range];
  if (days === null) {
    return { endDate, timeZone, contractVersion: USAGE_CONTRACT_VERSION };
  }
  const endUtcMs = Date.parse(`${endDate}T12:00:00.000Z`);
  const startDate = calendarDateInZone(endUtcMs - (days - 1) * 86_400_000, "UTC");
  return { startDate, endDate, timeZone, contractVersion: USAGE_CONTRACT_VERSION };
}
