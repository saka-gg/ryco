import { getQueuedThreadKeys } from "@ryco/client-runtime/state/message-queue";
import { useMemo } from "react";

import { useListedEnvironmentsWorkspaceData } from "../../state/homeData";
import { useMessageQueueStore } from "../../state/messageQueueStore";
import { useSnoozeWokeSeen } from "../../state/snoozeWokeSeen";
import { useHomeEnvironments } from "./useHomeEnvironments";

/**
 * What Home's Inbox is built from (`buildInboxSections`): the machines, their workspace data, the
 * threads with a message queued on this phone, and when this phone saw each woken thread. Home and
 * the Live Activity both read the Inbox through it, so the card never disagrees with the list it
 * opens. `nowMs` keeps cached Hub nodes' "last seen" text current.
 */
export function useInboxSource(nowMs: number) {
  const environments = useHomeEnvironments({ nowMs });
  const { projects, worktrees, threads } = useListedEnvironmentsWorkspaceData(environments);
  const queuesByThreadKey = useMessageQueueStore((state) => state.queuesByThreadKey);
  const localQueuedThreadIds = useMemo(
    () => getQueuedThreadKeys(queuesByThreadKey),
    [queuesByThreadKey],
  );
  const wokeSeenAtByThreadKey = useSnoozeWokeSeen();
  return useMemo(
    () => ({
      environments,
      projects,
      worktrees,
      threads,
      localQueuedThreadIds,
      wokeSeenAtByThreadKey,
    }),
    [environments, localQueuedThreadIds, projects, threads, wokeSeenAtByThreadKey, worktrees],
  );
}
