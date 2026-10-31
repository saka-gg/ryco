import type { InboxEnvironment } from "../../inbox/inboxModel";

/** What decides whether a device is asked for its statistics and provider limits. */
export type StatisticsAccessEnvironment = Pick<InboxEnvironment, "connectionState" | "role">;

/**
 * Why this device is not asked for statistics or provider limits right now, or `null` when it is:
 * it must be connected, and this phone must have owner access there. A viewer's or operator's
 * session shows someone else's subscriptions. The Limits tab and the subscription usage widget
 * both follow this one rule.
 */
export function statisticsUnavailableReason(
  environment: StatisticsAccessEnvironment,
): string | null {
  if (environment.connectionState !== "connected" && environment.connectionState !== "read-only")
    return "Connect this device to load current data.";
  if (environment.role === "viewer" || environment.role === "operator")
    return "Statistics and provider limits require owner access on this device.";
  return null;
}
