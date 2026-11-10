import * as Notifications from "expo-notifications";
import { useEffect, useMemo, useState } from "react";

import { useInboxSource } from "../../features/home/useInboxSource";
import { usePreferences } from "../../state/preferencesStore";
import { readMobileRycoPush } from "../push/pushKeyCustody";
import { createAppBadge, type AppBadge } from "./appBadge";
import { appBadgeCounts } from "./appBadgeModel";

/** How often a result's 15 minutes and a snooze's end are looked at again. */
const BADGE_CLOCK_MS = 60_000;

function createMobileAppBadge(): AppBadge {
  const native = readMobileRycoPush();
  const setBadgeCounts = native?.setBadgeCounts;
  const clearBadge = native?.clearBadge;
  return createAppBadge({
    native:
      setBadgeCounts !== undefined && clearBadge !== undefined
        ? { setBadgeCounts, clearBadge }
        : null,
    setBadgeCount: (count) => Notifications.setBadgeCountAsync(count),
  });
}

/**
 * Keeps the app icon badge on the Inbox's "needs you" count over every machine while the app runs
 * with thread alerts on (`ThreadAlertsBridge`). Turning alerts off or leaving the workspace
 * (sign-out) unmounts it, which clears the badge.
 */
export function AppBadgeFeed() {
  const [badge] = useState(createMobileAppBadge);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), BADGE_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  const source = useInboxSource(nowMs);
  const preferences = usePreferences();
  const counts = useMemo(
    () =>
      appBadgeCounts({
        source,
        autoSettleAfterDays: preferences.sidebarAutoSettleAfterDays,
        nowMs,
      }),
    [nowMs, preferences.sidebarAutoSettleAfterDays, source],
  );
  useEffect(() => {
    badge.update(counts);
  }, [badge, counts]);
  useEffect(
    () => () => {
      void badge.clear();
    },
    [badge],
  );
  return null;
}
