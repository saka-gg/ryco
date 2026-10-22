import { createComposerContextIntake } from "@ryco/client-runtime/state/composer";
import type { ScopedThreadRef } from "@ryco/contracts";
import { useCallback, useSyncExternalStore } from "react";

/**
 * The web app's one composer context intake. A thread's composer registers
 * while it is mounted; the Review and Files panels deliver line references to
 * the thread they show.
 */
export const composerContextIntake = createComposerContextIntake();

/** Whether `thread` has a composer taking context, so "Add to chat" can be offered. */
export function useComposerContextIntakeAvailable(thread: ScopedThreadRef | null): boolean {
  const environmentId = thread?.environmentId ?? null;
  const threadId = thread?.threadId ?? null;
  const read = useCallback(
    () =>
      environmentId !== null &&
      threadId !== null &&
      composerContextIntake.canDeliver({ environmentId, threadId }),
    [environmentId, threadId],
  );
  return useSyncExternalStore(composerContextIntake.subscribe, read, read);
}
