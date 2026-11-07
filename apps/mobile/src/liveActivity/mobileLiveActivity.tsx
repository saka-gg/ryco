import { summarizeAgentActivity } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import * as Linking from "expo-linking";
import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";

import { useInboxSource } from "../features/home/useInboxSource";
import { buildInboxSections } from "../features/inbox/inboxModel";
import { useHostedHubStore } from "../hostedHub/state";
import { threadAlertLinkPath } from "../notifications/threadAlerts.logic";
import { useEnvironmentServerConfigs } from "../state/environmentServerConfigs";
import { usePreferences } from "../state/preferencesStore";
import { startAgentWidgetRuntime, type AgentWidgetRuntime } from "../widgets/agentWidgetTimeline";
import { rycoWidgetsNative } from "../widgets/rycoWidgetsNative";
import {
  agentActivityContentState,
  agentActivityModelName,
  agentActivityThreads,
  type AgentActivityLinks,
} from "./agentActivityModel";
import { startLiveActivityRuntime, type LiveActivityRuntime } from "./liveActivityRuntime";

/** How often the results' 15 minutes are checked while Ryco runs. */
const RESULT_CLOCK_MS = 60_000;

const appState = {
  isActive: () => AppState.currentState === "active",
  subscribe: (listener: (active: boolean) => void) => {
    const subscription = AppState.addEventListener("change", (state) =>
      listener(state === "active"),
    );
    return () => subscription.remove();
  },
};

/** Where the card's and the widget's taps go: a thread, or the Inbox. */
export const mobileAgentActivityLinks: AgentActivityLinks = {
  inbox: Linking.createURL(""),
  thread: (environmentId, threadId) =>
    Linking.createURL(
      threadAlertLinkPath({
        environmentId: environmentId as EnvironmentId,
        threadId: threadId as ThreadId,
      }),
    ),
};

/** The app's Live Activity runtime, or null in a build without the widget extension. */
export function startMobileLiveActivity(
  options: { readonly pushUpdates?: () => boolean } = {},
): LiveActivityRuntime | null {
  const native = rycoWidgetsNative();
  if (native === null) return null;
  return startLiveActivityRuntime({
    native,
    links: mobileAgentActivityLinks,
    appState,
    ...(options.pushUpdates ? { pushUpdates: options.pushUpdates } : {}),
  });
}

/** The agent widget's runtime, or null in a build without widgets. */
export function startMobileAgentWidget(): AgentWidgetRuntime | null {
  const native = rycoWidgetsNative();
  return native === null ? null : startAgentWidgetRuntime({ native });
}

/**
 * Feeds the Live Activity and the agent widget the Inbox as Home builds it: the same source
 * (`useInboxSource`: machines, threads, messages queued on this phone, woken threads seen) and
 * rules, without Home's search and machine filter, so neither disagrees with the list it opens.
 * Computed once for both; each gets it only while it is on.
 */
export function AgentGlanceFeed({
  liveActivity,
  widget,
}: {
  readonly liveActivity: LiveActivityRuntime | null;
  readonly widget: AgentWidgetRuntime | null;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), RESULT_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  const source = useInboxSource(nowMs);
  const preferences = usePreferences();
  const account = useHostedHubStore((state) => state.account?.id ?? null);
  const configs = useEnvironmentServerConfigs();
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
      modelNameOf: (thread) => agentActivityModelName(thread, configs),
    });
    return {
      summary: summarizeAgentActivity(activityThreads, nowMs),
      known: activityThreads.some((thread) => thread.live),
    };
  }, [configs, nowMs, preferences.sidebarAutoSettleAfterDays, source]);
  useEffect(() => {
    liveActivity?.setSummary(glance.summary, glance.known, account);
  }, [account, glance, liveActivity]);
  useEffect(() => {
    widget?.setState(
      glance.known
        ? agentActivityContentState(glance.summary, mobileAgentActivityLinks, Date.now())
        : null,
    );
  }, [glance, widget]);
  return null;
}
