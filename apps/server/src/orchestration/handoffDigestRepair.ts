/**
 * What startup does with a session that a context handoff left in the digest error.
 *
 * Earlier versions checked a stored context document's digest after decoding it, and decoding
 * trims values, so a document holding a value cut just after whitespace was refused on its first
 * delivery. The handoff was rolled back, and a source that was not live stayed projected in error
 * with that message until the next send. Stored documents are now checked as they were stored;
 * when the failed handoff's document verifies, the error was never the thread's, and startup puts
 * the session back to rest. The failed handoff stays failed: it is terminal, and the next model
 * change or fork turn prepares a new one.
 *
 * @module handoffDigestRepair
 */
import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThread,
  type ThreadId,
} from "@ryco/contracts";

import type { ContextHandoffRecord } from "../persistence/Services/ContextHandoffs.ts";
import { CONTEXT_HANDOFF_DIGEST_MISMATCH_ERROR } from "./contextHandoff/ContextHandoffService.ts";

/**
 * An idle session, not live in this process, that still shows the digest error. A repaired
 * session no longer matches, so later boots only pay this filter.
 */
export function hasHandoffDigestFailureSession(
  thread: Pick<OrchestrationThread, "id" | "deletedAt" | "session">,
  liveThreadIds: ReadonlySet<ThreadId>,
): boolean {
  const session = thread.session;
  return (
    thread.deletedAt === null &&
    session !== null &&
    session.status === "error" &&
    session.activeTurnId === null &&
    session.lastError === CONTEXT_HANDOFF_DIGEST_MISMATCH_ERROR &&
    !liveThreadIds.has(thread.id)
  );
}

/** The thread's latest handoff that failed with the digest error: the one the session shows. */
export function latestDigestFailedHandoff(
  records: ReadonlyArray<ContextHandoffRecord>,
): ContextHandoffRecord | undefined {
  let latest: ContextHandoffRecord | undefined;
  for (const record of records) {
    if (record.status !== "failed" || record.error !== CONTEXT_HANDOFF_DIGEST_MISMATCH_ERROR) {
      continue;
    }
    if (latest === undefined || record.createdAt >= latest.createdAt) latest = record;
  }
  return latest;
}

/**
 * The one quiet session-set that puts the session back to rest: `stopped`, without the error,
 * and still dated at its own last update, so it is no new activity and wakes no snoozed thread.
 * Its command id derives from the session it repairs, so a retried boot reuses the receipt.
 */
export function handoffDigestFailureRelease(input: {
  readonly threadId: ThreadId;
  readonly session: OrchestrationSession;
  readonly repairedAt: string;
}): Extract<OrchestrationCommand, { type: "thread.session.set" }> {
  return {
    type: "thread.session.set",
    commandId: CommandId.make(
      `server:startup-handoff-digest-repair:${input.threadId}:${input.session.updatedAt}`,
    ),
    threadId: input.threadId,
    session: { ...input.session, status: "stopped", lastError: null },
    wakesSnoozed: false,
    createdAt: input.repairedAt,
  };
}
