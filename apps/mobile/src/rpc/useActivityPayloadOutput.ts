import { useAtomValue } from "@effect/atom-react";
import {
  isActivityPayloadOutdated,
  resolveActivityPayloadOutputView,
  type ActivityPayloadInput,
  type ActivityPayloadOutputView,
} from "@ryco/client-runtime/state/session";
import { useCallback, useEffect, useMemo } from "react";

import { activityPayloadQuery } from "./activityPayloadAtoms";

export interface ActivityPayloadOutput extends ActivityPayloadOutputView {
  readonly retry: () => void;
}

/**
 * The full output of a work row whose payload the thread window sent as a
 * preview, fetched while the row is open. Idle (no request) when `activityId`
 * is null, i.e. the row's output is already complete.
 */
export function useActivityPayloadOutput(input: ActivityPayloadInput): ActivityPayloadOutput {
  const { environmentId, threadId, activityId, payloadBytes } = input;
  const cacheKey = activityPayloadQuery.keyOf(input);
  useEffect(
    () => activityPayloadQuery.watch({ environmentId, threadId, activityId }),
    [environmentId, threadId, activityId],
  );
  const state = useAtomValue(activityPayloadQuery.getAtom(cacheKey));
  const retry = useCallback(() => activityPayloadQuery.refresh(cacheKey), [cacheKey]);
  // A running tool's output grew since it was fetched: read it again in place.
  const outdated = isActivityPayloadOutdated(state, payloadBytes);
  useEffect(() => {
    if (outdated) activityPayloadQuery.refresh(cacheKey);
  }, [outdated, cacheKey]);
  const view = useMemo(() => resolveActivityPayloadOutputView(cacheKey, state), [cacheKey, state]);
  return useMemo(() => ({ ...view, retry }), [view, retry]);
}
