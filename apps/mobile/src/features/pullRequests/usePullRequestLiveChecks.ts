import { useFocusEffect } from "@react-navigation/native";
import type { ChangeRequestChecksOverall } from "@ryco/client-runtime/state/pull-request-review";
import { useCallback } from "react";

import { mobileAppLifecycle } from "../../platform/appLifecycle";
import { pullRequestLiveChecksIntervalMs } from "./pullRequestCheckRingModel";

/**
 * Keeps an open pull request's checks current while its screen is focused and
 * the app is in the foreground, so a running CI moves on its own.
 */
export function usePullRequestLiveChecks(input: {
  readonly overall: ChangeRequestChecksOverall;
  readonly open: boolean;
  /** Must keep its identity across renders, or the timer restarts each render. */
  readonly refresh: () => Promise<unknown>;
}): void {
  const { overall, open, refresh } = input;
  useFocusEffect(
    useCallback(() => {
      if (!open) return;
      const timer = setInterval(() => {
        if (mobileAppLifecycle.isForeground()) void refresh();
      }, pullRequestLiveChecksIntervalMs(overall));
      return () => clearInterval(timer);
    }, [open, overall, refresh]),
  );
}
