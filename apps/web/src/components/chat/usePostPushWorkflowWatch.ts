import { useCallback, useEffect, useState } from "react";

import { invalidateSourceControl } from "~/rpc/useSourceControl";
import type { GitActionPostPushEvent } from "../GitActionsControl";
import {
  createPostPushWorkflowDiscoveryWatch,
  type PostPushWorkflowDiscoveryWatch,
} from "../postPushWorkflowDiscovery.logic";

/**
 * The thread's post-push workflow discovery watch. It lives with ChatView, not
 * the overview panel: the panel is loaded on demand and unmounts when it
 * closes, while a watch started by a push must survive both.
 */
export function usePostPushWorkflowWatch() {
  const [postPushWorkflowWatch, setPostPushWorkflowWatch] =
    useState<PostPushWorkflowDiscoveryWatch | null>(null);

  const handlePostPush = useCallback((event: GitActionPostPushEvent) => {
    setPostPushWorkflowWatch(
      createPostPushWorkflowDiscoveryWatch({
        environmentId: event.environmentId,
        threadKey: event.threadKey,
        cwd: event.cwd,
        pullRequestNumber: event.pullRequestNumber,
        commitSha: event.commitSha,
        nowMs: Date.now(),
      }),
    );
    invalidateSourceControl({ environmentId: event.environmentId, cwd: event.cwd });
  }, []);

  useEffect(() => {
    if (!postPushWorkflowWatch) return;
    const timeoutId = window.setTimeout(
      () =>
        setPostPushWorkflowWatch((current) => (current === postPushWorkflowWatch ? null : current)),
      Math.max(0, postPushWorkflowWatch.expiresAtMs - Date.now()),
    );
    return () => window.clearTimeout(timeoutId);
  }, [postPushWorkflowWatch]);

  const clearWatch = useCallback(() => {
    setPostPushWorkflowWatch(null);
  }, []);

  return { postPushWorkflowWatch, handlePostPush, clearWatch } as const;
}
