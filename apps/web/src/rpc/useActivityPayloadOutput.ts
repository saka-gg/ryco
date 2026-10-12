import { useAtomValue } from "@effect/atom-react";
import { deriveActivityPayloadOutput } from "@ryco/client-runtime/state/session";
import { useCallback, useEffect, useMemo } from "react";

import { activityPayloadQuery, type ActivityPayloadInput } from "./activityPayloadAtoms";

export interface ActivityPayloadOutput {
  readonly status: "idle" | "loading" | "loaded" | "error";
  /** The full output, once loaded; null while only the preview is available. */
  readonly output: string | null;
  readonly exitCode: number | null;
  /** The stored payload was still larger than one response, so `output` is cut short too. */
  readonly truncated: boolean;
  readonly retry: () => void;
}

/**
 * The full output of a work entry whose payload the thread window sent as a
 * preview. Idle (no request) when `activityId` is null, i.e. the entry's
 * output is already complete.
 */
export function useActivityPayloadOutput(input: ActivityPayloadInput): ActivityPayloadOutput {
  const { environmentId, threadId, activityId } = input;
  const cacheKey = activityPayloadQuery.keyOf(input);
  useEffect(
    () => activityPayloadQuery.watch({ environmentId, threadId, activityId }),
    [environmentId, threadId, activityId],
  );
  const state = useAtomValue(activityPayloadQuery.getAtom(cacheKey));
  const retry = useCallback(() => activityPayloadQuery.refresh(cacheKey), [cacheKey]);
  const derived = useMemo(
    () => (state.data ? deriveActivityPayloadOutput(state.data.payload) : null),
    [state.data],
  );
  if (cacheKey === null) {
    return { status: "idle", output: null, exitCode: null, truncated: false, retry };
  }
  if (derived && state.data) {
    return {
      status: "loaded",
      output: derived.output,
      exitCode: derived.exitCode,
      truncated: state.data.truncated,
      retry,
    };
  }
  return {
    status: state.error ? "error" : "loading",
    output: null,
    exitCode: null,
    truncated: false,
    retry,
  };
}
