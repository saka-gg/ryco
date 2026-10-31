import { summarizeAgentActivity } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import * as Linking from "expo-linking";
import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";

import { useInboxSource } from "../features/home/useInboxSource";
import { buildInboxSections } from "../features/inbox/inboxModel";
import { useHostedHubStore } from "../hostedHub/state";
import { threadAlertLinkPath } from "../notifications/threadAlerts.logic";
import { usePreferences } from "../state/preferencesStore";
import { rycoWidgetsNative } from "../widgets/rycoWidgetsNative";
import { agentActivityThreads } from "./agentActivityModel";
import { startLiveActivityRuntime, type LiveActivityRuntime } from "./liveActivityRuntime";

/** How often the results' 15 minutes are checked while Ryco runs. */
const RESULT_CLOCK_MS = 60_000;

/** The app's Live Activity runtime, or null in a build without the widget extension. */
export function startMobileLiveActivity(): LiveActivityRuntime | null {
  const native = rycoWidgetsNative();
  if (native === null) return null;
  return startLiveActivityRuntime({
    native,
    links: {
      inbox: Linking.createURL(""),
      thread: (environmentId, threadId) =>
        Linking.createURL(
          threadAlertLinkPath({
            environmentId: environmentId as EnvironmentId,
            threadId: threadId as ThreadId,
          }),
        ),
    },
    appState: {
      isActive: () => AppState.currentState === "active",
      subscribe: (listener) => {
        const subscription = AppState.addEventListener("change", (state) =>
          listener(state === "active"),
        );
        return () => subscription.remove();
      },
    },
  });
}

/**
 * Feeds the runtime the Inbox as Home builds it, while the switch is on: the same source
 * (`useInboxSource`: machines, threads, messages queued on this phone, woken threads seen) and
 * rules, without Home's search and machine filter, so the card never disagrees with the list it
 * opens.
 */
export function LiveActivityFeed({ runtime }: { readonly runtime: LiveActivityRuntime }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), RESULT_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  const source = useInboxSource(nowMs);
  const preferences = usePreferences();
  const account = useHostedHubStore((state) => state.account?.id ?? null);
  const glance = useMemo(() => {
    const sections = buildInboxSections({
      ...source,
      autoSettleAfterDays: preferences.sidebarAutoSettleAfterDays,
      nowMs,
    });
    const activityThreads = agentActivityThreads({
      sections,
      threads: source.threads,
      environments: source.environments,
    });
    return {
      summary: summarizeAgentActivity(activityThreads, nowMs),
      known: activityThreads.some((thread) => thread.live),
    };
  }, [nowMs, preferences.sidebarAutoSettleAfterDays, source]);
  useEffect(() => {
    runtime.setSummary(glance.summary, glance.known, account);
  }, [account, glance, runtime]);
  return null;
}
