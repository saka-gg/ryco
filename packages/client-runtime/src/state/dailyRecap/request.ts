// @effect-diagnostics globalDate:off
import type { DailyRecapRequest } from "@ryco/contracts/daily-recap";
import type { UsageCalendarDate } from "@ryco/contracts/usage";

import { calendarDateInZone } from "../../usage/request.ts";

/**
 * The recap of the local calendar day that contains `nowMs` in `timeZone`.
 * Every node is asked for the client's day, so their answers add up.
 */
export function dailyRecapRequest(nowMs: number, timeZone: string): DailyRecapRequest {
  return { date: calendarDateInZone(nowMs, timeZone), timeZone };
}

/** The calendar date before `date`, counted in UTC so no clock change can skip or repeat one. */
export function previousCalendarDate(date: UsageCalendarDate): UsageCalendarDate {
  return calendarDateInZone(Date.parse(`${date}T12:00:00.000Z`) - 86_400_000, "UTC");
}

/**
 * The recap of the day before `request`'s, in the same time zone. Only its
 * totals are read, so it asks for one thread per section instead of twenty.
 */
export function previousDayRecapRequest(request: DailyRecapRequest): DailyRecapRequest {
  return { date: previousCalendarDate(request.date), timeZone: request.timeZone, limit: 1 };
}
