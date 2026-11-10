import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useEffect, useState } from "react";

import { usePreferences } from "../../state/preferencesStore";
import {
  alertExcerptPrompts,
  NO_ALERT_EXCERPT_PROMPTS,
  type AlertExcerptPrompts,
} from "./alertExcerpts";
import { readMobileRycoPush } from "./pushKeyCustody";

/**
 * The waiting approval or question a background alert described for this thread
 * (`alertExcerpts.ts`), while the thread's live detail has not loaded. Reads the extension's
 * saved record once per thread opened, only on a device that ever turned background alerts on;
 * once the live detail is there, the record is removed and nothing provisional shows again.
 */
export function useAlertExcerptPrompts(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The thread's live (not cached) detail loaded: its own cards take over. */
  readonly liveLoaded: boolean;
}): AlertExcerptPrompts {
  const backgroundAlertsEverOn = usePreferences().backgroundAlerts !== undefined;
  const [read, setRead] = useState<{
    readonly key: string;
    readonly prompts: AlertExcerptPrompts;
  } | null>(null);
  const { environmentId, threadId, liveLoaded } = input;
  const key = `${environmentId}\n${threadId}`;

  useEffect(() => {
    if (!backgroundAlertsEverOn) return;
    const native = readMobileRycoPush();
    if (native === null) return;
    if (liveLoaded) {
      void native.removeAlertExcerpt?.(environmentId, threadId).catch(() => undefined);
      return;
    }
    const readExcerpt = native.readAlertExcerpt;
    if (readExcerpt === undefined) return;
    let active = true;
    void readExcerpt(environmentId, threadId)
      .then((json) => {
        if (!active || json === null) return;
        const prompts = alertExcerptPrompts({ json, environmentId, threadId, nowMs: Date.now() });
        if (prompts !== null) setRead({ key: `${environmentId}\n${threadId}`, prompts });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [backgroundAlertsEverOn, environmentId, liveLoaded, threadId]);

  return !liveLoaded && read !== null && read.key === key ? read.prompts : NO_ALERT_EXCERPT_PROMPTS;
}
