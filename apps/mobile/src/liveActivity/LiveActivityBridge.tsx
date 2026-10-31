import { useEffect, useState } from "react";

import { runWhenIdle } from "../navigation/idlePrewarm";
import { usePreferences } from "../state/preferencesStore";
import type { LiveActivityRuntime } from "./liveActivityRuntime";

type MobileLiveActivityModule = typeof import("./mobileLiveActivity");

// At module scope: the React Compiler cannot compile a component that calls import() itself.
const loadMobileLiveActivity = (): Promise<MobileLiveActivityModule> =>
  import("./mobileLiveActivity");
const loadEndLiveActivities = (): Promise<typeof import("./endLiveActivities")> =>
  import("./endLiveActivities");

/**
 * The agent Live Activity, off by default. It loads after launch, once the app is idle and only
 * once its switch was ever turned on, and keeps running after it is turned off so it can end the
 * card. The Inbox feed runs only while the switch is on. Leaving the workspace (sign-out) ends
 * every card at once.
 */
export function LiveActivityBridge() {
  const preferences = usePreferences();
  // Unset until the switch is first turned on; off afterwards is `false`.
  const touched = preferences.liveActivitiesEnabled !== undefined;
  const enabled = preferences.liveActivitiesEnabled === true;
  const [loaded, setLoaded] = useState<{
    readonly module: MobileLiveActivityModule;
    readonly runtime: LiveActivityRuntime;
  } | null>(null);

  useEffect(() => {
    if (!touched) return;
    let active = true;
    let runtime: LiveActivityRuntime | null = null;
    runWhenIdle(() => {
      if (!active) return;
      void loadMobileLiveActivity()
        .then((module) => {
          if (!active) return;
          runtime = module.startMobileLiveActivity();
          if (runtime !== null) setLoaded({ module, runtime });
        })
        .catch((error: unknown) => console.warn("The Live Activity failed to load.", error));
    });
    return () => {
      active = false;
      void runtime?.stop();
    };
  }, [touched]);

  useEffect(() => {
    loaded?.runtime.setEnabled(enabled);
  }, [enabled, loaded]);

  if (loaded === null || !enabled) return null;
  const { LiveActivityFeed } = loaded.module;
  return <LiveActivityFeed runtime={loaded.runtime} />;
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
