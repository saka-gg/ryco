import { useMemo } from "react";

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import { createThreadTimelineBuilder, type ThreadTimeline } from "./threadTimelineModel";
import { selectThreadByRef, useStore } from "./threadsRuntime";

export { buildThreadTimeline } from "./threadTimelineModel";
export type { ThreadTimeline } from "./threadTimelineModel";

// The React hook: reads the merged thread from runtime A's store and derives its
// timeline. Recomputed only when the thread object changes.
export function useThreadTimeline(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadTimeline | null {
  const thread = useStore((state) =>
    selectThreadByRef(state, scopeThreadRef(environmentId, threadId)),
  );
  const buildTimeline = useMemo(() => createThreadTimelineBuilder(), []);
  return useMemo(() => buildTimeline(thread), [buildTimeline, thread]);
}
