import {
  type ComposerContextItem,
  createComposerContextIntake,
} from "@ryco/client-runtime/state/composer";
import type { ScopedThreadRef } from "@ryco/contracts";
import { useCallback, useSyncExternalStore } from "react";

/**
 * The web app's one composer context intake. A thread's composer registers
 * while it is mounted; the Review and Files panels deliver line references,
 * and a thread's Browser panel page elements, to the thread they show.
 */
export const composerContextIntake = createComposerContextIntake();

/**
 * How "Add to chat" went for a picked reference: `invalid` when no reference
 * could be made of the pick and `full` when the message holds as many of its
 * kind as it carries (retrying cannot help either), `refused` when the
 * composer cannot take it now.
 */
export type ReferenceAddResult = "added" | "refused" | "full" | "invalid";

/** Hands a picked reference to `thread`'s composer, for every panel's "Add to chat". */
export function addReferenceToComposer(
  thread: ScopedThreadRef,
  item: ComposerContextItem,
): Exclude<ReferenceAddResult, "invalid"> {
  const delivery = composerContextIntake.deliver(thread, item);
  return delivery === "added" || delivery === "full" ? delivery : "refused";
}

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
