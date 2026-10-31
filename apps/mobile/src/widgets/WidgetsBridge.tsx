import { useEffect, useState } from "react";

import { runWhenIdle } from "../navigation/idlePrewarm";
import type { WidgetsRuntime } from "./widgetsRuntime";

type MobileWidgetsModule = typeof import("./mobileWidgetsRuntime");

// At module scope: the React Compiler cannot compile a component that calls import() itself.
const loadMobileWidgets = (): Promise<MobileWidgetsModule> => import("./mobileWidgetsRuntime");
const loadClearWidgets = (): Promise<typeof import("./clearWidgets")> => import("./clearWidgets");

/**
 * Keeps the Home and Lock Screen widgets current while the workspace is unlocked. The widgets
 * runtime loads after launch, once the app is idle, so it never delays the first frames; a build
 * without widgets loads it and does nothing. Leaving the workspace (sign-out) empties them.
 */
export function WidgetsBridge() {
  const [loaded, setLoaded] = useState<{
    readonly module: MobileWidgetsModule;
    readonly runtime: WidgetsRuntime;
  } | null>(null);

  useEffect(() => {
    let active = true;
    let runtime: WidgetsRuntime | null = null;
    runWhenIdle(() => {
      if (!active) return;
      void loadMobileWidgets()
        .then((module) => {
          if (!active) return;
          runtime = module.startMobileWidgets();
          if (runtime !== null) setLoaded({ module, runtime });
        })
        .catch((error: unknown) => console.warn("The widgets failed to load.", error));
    });
    return () => {
      active = false;
      void runtime?.stop({ clear: true });
    };
  }, []);

  if (loaded === null) return null;
  const { WidgetsFeed } = loaded.module;
  return <WidgetsFeed runtime={loaded.runtime} />;
}

/**
 * On the sign-in screen: empties the widgets once the app is idle. Signing out while Ryco was
 * closed (or a session that ended meanwhile) leaves the last timeline behind, and the workspace's
 * bridge never mounts on a locked launch. It loads only the small clearing module.
 */
export function LockedWidgetsBridge() {
  useEffect(() => {
    let active = true;
    runWhenIdle(() => {
      if (!active) return;
      void loadClearWidgets()
        .then(({ clearWidgets }) => (active ? clearWidgets() : undefined))
        .catch((error: unknown) => console.warn("The widgets were not cleared.", error));
    });
    return () => {
      active = false;
    };
  }, []);
  return null;
}
