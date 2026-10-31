import { useEffect } from "react";

import { runWhenIdle } from "../navigation/idlePrewarm";

type MobileWidgetsModule = typeof import("./mobileWidgetsRuntime");

// At module scope: the React Compiler cannot compile a component that calls import() itself.
const loadMobileWidgets = (): Promise<MobileWidgetsModule> => import("./mobileWidgetsRuntime");

/**
 * Keeps the Home and Lock Screen widgets current while the workspace is unlocked. The widgets
 * runtime loads after launch, once the app is idle, so it never delays the first frames; a build
 * without widgets loads it and does nothing. Leaving the workspace (sign-out) empties them.
 */
export function WidgetsBridge() {
  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    runWhenIdle(() => {
      if (!active) return;
      void loadMobileWidgets()
        .then(({ startMobileWidgets }) => {
          if (active) stop = startMobileWidgets();
        })
        .catch((error: unknown) => console.warn("The widgets failed to load.", error));
    });
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  return null;
}
