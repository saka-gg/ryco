import { useEffect, useMemo } from "react";

import { scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import type { Thread } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import {
  mergeOptimisticMessages,
  settleOptimisticUserMessages,
  useOptimisticUserMessages,
} from "./optimisticUserMessages";
import { createThreadTimelineBuilder, type ThreadTimeline } from "./threadTimelineModel";
import { selectThreadByRef, useStore } from "./threadsRuntime";

export { buildThreadTimeline } from "./threadTimelineModel";
export type { ThreadTimeline } from "./threadTimelineModel";

// The React hook: reads the merged thread from runtime A's store and derives its
// timeline, with this device's unconfirmed sends after the node's messages.
// Recomputed only when the thread object or those sends change.
export function useThreadTimeline(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadTimeline | null {
  const thread = useStore((state) =>
    selectThreadByRef(state, scopeThreadRef(environmentId, threadId)),
  );
  return useThreadTimelineOf(environmentId, threadId, thread);
}

/**
 * The timeline of a thread the caller already holds (the thread screen's chrome selection,
 * which skips streamed text), with this device's unconfirmed sends after the node's messages.
 */
export function useThreadTimelineOf(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  thread: Thread | null | undefined,
): ThreadTimeline | null {
  const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));
  const pending = useOptimisticUserMessages(threadKey);
  const buildTimeline = useMemo(() => createThreadTimelineBuilder(), []);
  const serverMessages = thread?.messages;
  const messages = useMemo(
    () => (serverMessages ? mergeOptimisticMessages(serverMessages, pending) : undefined),
    [serverMessages, pending],
  );
  // The echo carries the send's message id: once it is in, the send is done.
  useEffect(() => {
    if (!serverMessages || pending.length === 0) return;
    settleOptimisticUserMessages(
      threadKey,
      new Set(serverMessages.map((message) => message.id as string)),
    );
  }, [pending, serverMessages, threadKey]);
  return useMemo(
    () =>
      thread && messages
        ? buildTimeline(
            messages === thread.messages ? thread : { ...thread, messages: [...messages] },
          )
        : null,
    [buildTimeline, messages, thread],
  );
}
