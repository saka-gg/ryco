import { useEffect, useState } from "react";

import { runWhenIdle } from "../../../navigation/idlePrewarm";

type SettingsSharingFeedModule = typeof import("./SettingsSharingFeed");

// At module scope: the React Compiler cannot compile a component that calls import() itself.
const loadFeed = (): Promise<SettingsSharingFeedModule> => import("./SettingsSharingFeed");

/**
 * Shared device settings while the workspace is unlocked: a node that comes back online catches
 * up on a shared setting it missed while the phone is open, settings screen or not. Loads once
 * the app is idle, so it never delays the first frames.
 */
export function SettingsSharingBridge() {
  const [feed, setFeed] = useState<SettingsSharingFeedModule | null>(null);
  useEffect(() => {
    let active = true;
    runWhenIdle(() => {
      if (!active) return;
      void loadFeed()
        .then((module) => {
          if (active) setFeed(module);
        })
        .catch((error: unknown) => console.warn("Shared settings failed to load.", error));
    });
    return () => {
      active = false;
    };
  }, []);
  if (feed === null) return null;
  const { SettingsSharingFeed } = feed;
  return <SettingsSharingFeed />;
}
