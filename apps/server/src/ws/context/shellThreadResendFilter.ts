/**
 * Keeps a shell subscription from sending a thread row its client already has.
 *
 * While an agent streams, every coalescing window (250 ms) re-reads the thread's row and sent it
 * to every client, although for assistant text the only field that moved is `updatedAt`. A row
 * equal to the last one sent to this subscriber is dropped; one that differs only in `updatedAt`
 * is dropped while the last send is younger than {@link SHELL_THREAD_TIMESTAMP_RESEND_MS}, so a
 * client sorting by recency still sees a streaming thread move up within that time. Every other
 * change (title, session status, latest turn, approvals, liveness, ...) is sent at once.
 *
 * The client's shell cursor moves with the items it receives, so a dropped row leaves it at most
 * that long behind on a thread that only streams text; a resume then replays a little more.
 *
 * @module shellThreadResendFilter
 */
import type { OrchestrationShellStreamEvent, OrchestrationThreadShell } from "@ryco/contracts";

export const SHELL_THREAD_TIMESTAMP_RESEND_MS = 10_000;

/** Deep equality of JSON values; `ignoreKey` is skipped at the top level only. */
export function sameJsonValue(left: unknown, right: unknown, ignoreKey?: string): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameJsonValue(left[index], right[index])) return false;
    }
    return true;
  }
  if (Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  let leftKeys = 0;
  for (const key in leftRecord) {
    if (key === ignoreKey || leftRecord[key] === undefined) continue;
    leftKeys += 1;
    if (!sameJsonValue(leftRecord[key], rightRecord[key])) return false;
  }
  let rightKeys = 0;
  for (const key in rightRecord) {
    if (key === ignoreKey || rightRecord[key] === undefined) continue;
    rightKeys += 1;
  }
  return leftKeys === rightKeys;
}

/** One subscription's filter: `true` keeps the item. */
export function makeShellThreadResendFilter(
  now: () => number = Date.now,
): (item: OrchestrationShellStreamEvent) => boolean {
  const sent = new Map<string, { readonly row: OrchestrationThreadShell; readonly at: number }>();
  return (item) => {
    if (item.kind === "thread-removed") {
      sent.delete(item.threadId);
      return true;
    }
    if (item.kind !== "thread-upserted") return true;
    const previous = sent.get(item.thread.id);
    const at = now();
    if (previous !== undefined && sameJsonValue(previous.row, item.thread, "updatedAt")) {
      if (
        previous.row.updatedAt === item.thread.updatedAt ||
        at - previous.at < SHELL_THREAD_TIMESTAMP_RESEND_MS
      ) {
        return false;
      }
    }
    sent.set(item.thread.id, { row: item.thread, at });
    return true;
  };
}
