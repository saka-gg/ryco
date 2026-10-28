import { useEffect, useState } from "react";

import { scheduleIdleTask } from "./idleTask";
import { type PreloadableModule, useLazyComponentReady } from "./preloadableLazy";

/**
 * Whether an optional code-split part of a surface can mount. Its chunk loads
 * in an idle slot after the caller mounts, off the shell's critical path. A
 * failed load is logged under `label` and leaves the part out: the surface
 * works without it and must not be taken down by it.
 */
export function useIdleLazyComponentReady(component: PreloadableModule, label: string): boolean {
  const [wanted, setWanted] = useState(component.isLoaded);
  useEffect(() => (wanted ? undefined : scheduleIdleTask(() => setWanted(true))), [wanted]);
  return useLazyComponentReady(component, wanted, {
    onLoadError: (error) => console.warn(`${label} failed to load.`, error),
  });
}
