import type { EnvironmentId } from "@ryco/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  ensureMobileThreadConnectionRetargetEngine,
  type ThreadConnectionDegradedReason,
} from "./threadConnectionRetarget";

/**
 * Declare, for as long as this thread surface is mounted, that its environment
 * should be the hosted selection — and read back the reason when it cannot be.
 * An environment whose session is already live or on its way is selected
 * without waiting; any other waits out the engine's short debounce first.
 *
 * Deliberately the only React surface of the retarget engine, and deliberately
 * thin: all of the decision and timing logic lives in
 * `threadConnectionRetarget.ts` where it can be tested (react-native ships
 * untranspiled Flow, so no component test can ever exercise this file).
 *
 * Keyed on `environmentId`: a `StackActions.replace` between two threads on the
 * same node re-runs nothing, and a replace across nodes releases the old intent
 * and opens the new one through the engine's refcount, so the double-mount that
 * a replace (and iPad's ThreadFilesRouteScreen) produces cannot cancel an
 * intent that is still wanted.
 */
export function useThreadConnectionRetarget(
  environmentId: EnvironmentId,
): ThreadConnectionDegradedReason | null {
  useEffect(
    () => ensureMobileThreadConnectionRetargetEngine().open(environmentId),
    [environmentId],
  );

  const subscribe = useCallback(
    (listener: () => void) => ensureMobileThreadConnectionRetargetEngine().subscribe(listener),
    [],
  );
  const getSnapshot = useCallback(
    () => ensureMobileThreadConnectionRetargetEngine().readDegradedReason(environmentId),
    [environmentId],
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}
