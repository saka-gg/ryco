import type { EnvironmentId, ScopedThreadRef, TerminalEvent } from "@ryco/contracts";
import { ThreadId } from "@ryco/contracts/base-schemas";

import { scopeThreadRef } from "../../scoped.ts";

/**
 * Whether a terminal event belongs to a thread the client may still present.
 *
 * A server thread wins over a same-id local draft: an archived server thread
 * rejects terminal events. Before a draft is promoted there is no server thread
 * yet, so the draft is the only evidence that the event belongs to a live
 * client thread.
 */
export function shouldApplyTerminalEvent(input: {
  readonly serverThreadArchivedAt: string | null | undefined;
  readonly hasDraftThread: boolean;
}): boolean {
  if (input.serverThreadArchivedAt !== undefined) {
    return input.serverThreadArchivedAt === null;
  }

  return input.hasDraftThread;
}

export interface TerminalEventAdmissionPorts {
  /** The thread's shell entry, stub or full: `undefined` when the node lists no such thread. */
  readonly readServerThreadArchivedAt: (threadRef: ScopedThreadRef) => string | null | undefined;
  readonly hasDraftThread: (threadRef: ScopedThreadRef) => boolean;
  readonly applyTerminalEvent: (threadRef: ScopedThreadRef, event: TerminalEvent) => void;
  /**
   * Whether the environment's shell snapshot has arrived. A connection's
   * terminal catch-up can land before it, when no thread is listed yet; a
   * platform that drops orphaned terminal state once the snapshot arrives
   * passes this so those events are kept until then. Without it an unlisted
   * thread's events are always dropped.
   */
  readonly isShellBootstrapped?: (environmentId: EnvironmentId) => boolean;
}

/**
 * The one terminal-event admission path every client plane feeds: it scopes
 * the event to its environment's thread and applies it only for a thread
 * `shouldApplyTerminalEvent` admits. A plane that fences connection
 * generations (hosted relay sessions) checks its generation before calling it.
 */
export function createTerminalEventAdmission(ports: TerminalEventAdmissionPorts) {
  return (event: TerminalEvent, environmentId: EnvironmentId): boolean => {
    const threadRef = scopeThreadRef(environmentId, ThreadId.make(event.threadId));
    const serverThreadArchivedAt = ports.readServerThreadArchivedAt(threadRef);
    const awaitingShell =
      serverThreadArchivedAt === undefined &&
      ports.isShellBootstrapped !== undefined &&
      !ports.isShellBootstrapped(environmentId);
    if (
      !awaitingShell &&
      !shouldApplyTerminalEvent({
        serverThreadArchivedAt,
        hasDraftThread: ports.hasDraftThread(threadRef),
      })
    ) {
      return false;
    }
    ports.applyTerminalEvent(threadRef, event);
    return true;
  };
}
