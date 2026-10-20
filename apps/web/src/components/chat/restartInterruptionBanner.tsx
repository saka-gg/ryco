import {
  restartInterruptionNotice,
  type RestartInterruptionThread,
} from "@ryco/client-runtime/state/threads";
import { InfoIcon } from "lucide-react";
import { useMemo } from "react";

import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * The composer banner for a thread a server restart interrupted: a quiet info line
 * where the user would continue, never the thread error notification. Null when no
 * restart released the thread or its node already explained the interruption.
 */
export function useRestartInterruptionBannerItem(
  thread: RestartInterruptionThread | null,
): ComposerBannerStackItem | null {
  const notice = thread ? restartInterruptionNotice(thread) : null;
  return useMemo(
    () =>
      notice === null
        ? null
        : { id: "restart-interruption", variant: "info", icon: <InfoIcon />, title: notice },
    [notice],
  );
}
