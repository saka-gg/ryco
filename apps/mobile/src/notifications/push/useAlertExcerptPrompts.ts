import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useEffect, useState } from "react";

import {
  alertExcerptPrompts,
  NO_ALERT_EXCERPT_PROMPTS,
  type AlertExcerptPrompts,
} from "./alertExcerpts";
import { readMobileRycoPush } from "./pushKeyCustody";

/**
 * The waiting approval or question a background alert described for this thread
 * (`alertExcerpts.ts`), while the thread's live detail has not loaded. Reads the extension's
 * saved record once per thread opened (one small file lookup; there is a file only when an alert
 * left one); once the live detail is there, a record it found is removed and nothing provisional
 * shows again.
 */
export function useAlertExcerptPrompts(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The thread's live (not cached) detail loaded: its own cards take over. */
  readonly liveLoaded: boolean;
}): AlertExcerptPrompts {
  const [read, setRead] = useState<{
    readonly key: string;
    readonly prompts: AlertExcerptPrompts;
  } | null>(null);
  const { environmentId, threadId, liveLoaded } = input;
  const key = `${environmentId}\n${threadId}`;
  const found = read !== null && read.key === key;

  useEffect(() => {
    if (liveLoaded) return;
    const readExcerpt = readMobileRycoPush()?.readAlertExcerpt;
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
  }, [environmentId, liveLoaded, threadId]);

  useEffect(() => {
    if (!liveLoaded || !found) return;
    void readMobileRycoPush()
      ?.removeAlertExcerpt?.(environmentId, threadId)
      .catch(() => undefined);
  }, [environmentId, found, liveLoaded, threadId]);

  return !liveLoaded && found ? read.prompts : NO_ALERT_EXCERPT_PROMPTS;
}
