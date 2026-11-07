import { useEffect, useState } from "react";
import { AppState } from "react-native";

import { runWhenIdle } from "../navigation/idlePrewarm";
import { usePreferences } from "../state/preferencesStore";
import type { AgentWidgetRuntime } from "../widgets/agentWidgetTimeline";
import type { LiveActivityRuntime } from "./liveActivityRuntime";

type MobileLiveActivityModule = typeof import("./mobileLiveActivity");

// At module scope: the React Compiler cannot compile a component that calls import() itself.
const loadMobileLiveActivity = (): Promise<MobileLiveActivityModule> =>
  import("./mobileLiveActivity");
const loadEndLiveActivities = (): Promise<typeof import("./endLiveActivities")> =>
  import("./endLiveActivities");
const loadLiveActivityPush = (): Promise<typeof import("./liveActivityPush")> =>
  import("./liveActivityPush");
const loadAgentWidgetInstalled = (): Promise<typeof import("../widgets/agentWidgetInstalled")> =>
  import("../widgets/agentWidgetInstalled");

/**
 * Whether the agent widget is on a Home or Lock Screen: asked once the app is idle and again on
 * each return to the foreground, so the Inbox feed runs only for a widget someone added.
 */
function useAgentWidgetInstalled(): boolean {
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    let active = true;
    const check = () => {
      void loadAgentWidgetInstalled()
        .then(({ isAgentWidgetInstalled }) => isAgentWidgetInstalled())
        .then((installed) => {
          if (active) setInstalled(installed);
        })
        .catch(() => undefined);
    };
    runWhenIdle(() => {
      if (active) check();
    });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return installed;
}

/**
 * The agent Live Activity, off by default, and the agent widget. They load after launch, once
 * the app is idle: the Live Activity only once its switch was ever turned on, and keeps running
 * after it is turned off so it can end the card; the widget once it is on a screen. The Inbox
 * feed runs only while one of them is on. Leaving the workspace (sign-out) ends every card at
 * once and empties the widget.
 */
export function LiveActivityBridge() {
  const preferences = usePreferences();
  // Unset until the switch is first turned on; off afterwards is `false`.
  const touched = preferences.liveActivitiesEnabled !== undefined;
  const enabled = preferences.liveActivitiesEnabled === true;
  const widgetInstalled = useAgentWidgetInstalled();
  const wanted = touched || widgetInstalled;
  const [loaded, setLoaded] = useState<{
    readonly module: MobileLiveActivityModule;
    readonly widget: AgentWidgetRuntime | null;
  } | null>(null);
  const [liveActivity, setLiveActivity] = useState<LiveActivityRuntime | null>(null);

  useEffect(() => {
    if (!wanted) return;
    let active = true;
    let widget: AgentWidgetRuntime | null = null;
    runWhenIdle(() => {
      if (!active) return;
      void loadMobileLiveActivity()
        .then((module) => {
          if (!active) return;
          widget = module.startMobileAgentWidget();
          setLoaded({ module, widget });
        })
        .catch((error: unknown) => console.warn("The Live Activity failed to load.", error));
    });
    return () => {
      active = false;
      setLoaded(null);
      void widget?.stop({ clear: true });
    };
  }, [wanted]);

  useEffect(() => {
    if (!touched || loaded === null) return;
    let stopPush: (() => void) | null = null;
    let active = true;
    // Push updates only where the Hub sends them; the card is local otherwise.
    let pushUpdatesAvailable = false;
    const push = loadLiveActivityPush().then((module) => (active ? module : null));
    const runtime = loaded.module.startMobileLiveActivity({
      pushUpdates: () => pushUpdatesAvailable,
    });
    void push
      .then((module) => {
        if (module === null) return;
        stopPush = module.startMobileLiveActivityPush({
          setAvailable: (available) => {
            pushUpdatesAvailable = available;
          },
        });
      })
      .catch((error: unknown) => console.warn("Live Activity push updates failed to load.", error));
    setLiveActivity(runtime);
    return () => {
      active = false;
      stopPush?.();
      setLiveActivity(null);
      void runtime?.stop();
    };
  }, [loaded, touched]);

  useEffect(() => {
    liveActivity?.setEnabled(enabled);
  }, [enabled, liveActivity]);

  if (loaded === null) return null;
  const feedLiveActivity = enabled ? liveActivity : null;
  const feedWidget = widgetInstalled ? loaded.widget : null;
  if (feedLiveActivity === null && feedWidget === null) return null;
  const { AgentGlanceFeed } = loaded.module;
  return <AgentGlanceFeed liveActivity={feedLiveActivity} widget={feedWidget} />;
}

/**
 * On the sign-in screen, once the switch was ever on: ends every card once the app is idle. A
 * sign-out while Ryco was closed (or a session that ended meanwhile) leaves the card and its
 * titles, and the workspace's bridge never mounts on a locked launch. It loads only the small
 * module that ends the cards.
 */
export function LockedLiveActivityBridge() {
  const preferences = usePreferences();
  const touched = preferences.liveActivitiesEnabled !== undefined;
  useEffect(() => {
    if (!touched) return;
    let active = true;
    runWhenIdle(() => {
      if (!active) return;
      void loadEndLiveActivities()
        .then(({ endLiveActivities }) => (active ? endLiveActivities() : undefined))
        .catch((error: unknown) => console.warn("The Live Activity was not ended.", error));
    });
    return () => {
      active = false;
    };
  }, [touched]);
  return null;
}
