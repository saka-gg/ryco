import type { ModelSwitchBlockedByBackgroundWork } from "@ryco/contracts";

import type { CommitSendTurnDispatchInput } from "./sendEngine.ts";

/**
 * The background tasks that made the node refuse a send's model switch
 * (`modelSwitchBlockedByBackgroundWork`), or null for any other failure. Reads
 * the error's tag and that key only, never its message: relay transports can
 * decode the error without its class, and nodes that predate the guard never
 * refuse a switch for this reason.
 */
export function readModelSwitchBlockedByBackgroundWork(
  error: unknown,
): ModelSwitchBlockedByBackgroundWork | null {
  if (typeof error !== "object" || error === null) return null;
  const { _tag, modelSwitchBlockedByBackgroundWork: blocked } = error as {
    readonly _tag?: unknown;
    readonly modelSwitchBlockedByBackgroundWork?: { readonly taskIds?: unknown };
  };
  if (_tag !== "OrchestrationDispatchCommandError" || !Array.isArray(blocked?.taskIds)) {
    return null;
  }
  return { taskIds: blocked.taskIds.filter((taskId) => typeof taskId === "string") };
}

/** A send that ended at the "Stop tasks and switch" choice; nothing more was sent. */
export class ModelSwitchBackgroundWorkError extends Error {
  readonly _tag = "ModelSwitchBackgroundWorkError";
}

/**
 * A send that background tasks held back and that was not sent: the user
 * cancelled the choice, its connection changed during it, or no one could be
 * asked (the node's refusal itself). Nothing was recorded for the message, so
 * a queue keeps it for an explicit retry instead of dropping it.
 */
export function isModelSwitchBackgroundWorkError(error: unknown): boolean {
  return (
    error instanceof ModelSwitchBackgroundWorkError ||
    readModelSwitchBlockedByBackgroundWork(error) !== null
  );
}

/** The "Stop tasks and switch" choice as every client presents it. */
export const STOP_BACKGROUND_WORK_TITLE = "Stop background tasks to switch?";
export const STOP_BACKGROUND_WORK_CONFIRM_LABEL = "Stop tasks and switch";

export function describeModelSwitchBlockedByBackgroundWork(
  blocked: ModelSwitchBlockedByBackgroundWork,
): string {
  const count = blocked.taskIds.length;
  return count === 1
    ? "A background task is still running in this thread, and switching the model now stops it. Stop it and switch, or cancel to keep your message and the selected model until it finishes."
    : `${count} background tasks are still running in this thread, and switching the model now stops them. Stop them and switch, or cancel to keep your message and the selected model until they finish.`;
}

/**
 * Starts the turn through `start`. When the node refuses its model switch
 * because the thread's background tasks are still running, the user chooses:
 * "Stop tasks and switch" sends the same command again, under the same command
 * id, marked `stopBackgroundWork`. The node then switches, and replacing the
 * provider runtime ends the tasks with it. Nothing is stopped before the node
 * accepts the switch, so a retry it refuses for another reason leaves the
 * tasks running. The retry is restamped: the time spent deciding is not work.
 * Cancelling (or a caller without `confirmStopBackgroundWork`) ends the send
 * with an error, and the caller keeps the draft and the staged target, as for
 * any failed send.
 */
export async function startTurnPastBackgroundWork(
  input: CommitSendTurnDispatchInput,
  start: (retry?: { readonly createdAt: string }) => Promise<unknown>,
): Promise<void> {
  try {
    await start();
    return;
  } catch (error) {
    const blocked = readModelSwitchBlockedByBackgroundWork(error);
    if (blocked === null || !input.confirmStopBackgroundWork) throw error;
    // The node recorded nothing: the send is not running while the user decides.
    input.endLocalDispatch?.();
    if (!(await input.confirmStopBackgroundWork(blocked))) {
      throw new ModelSwitchBackgroundWorkError(
        "Send cancelled. Your message and the selected model are kept, and the background tasks keep running.",
      );
    }
    // Like any choice made in a dialog, it only applies to the connection it was made on.
    try {
      input.assertMutationReady?.();
    } catch (cause) {
      throw new ModelSwitchBackgroundWorkError(
        "The connection changed before the model was switched. Nothing was stopped or sent; your message and the selected model are kept.",
        { cause },
      );
    }
    input.beginLocalDispatch({ preparingWorktree: Boolean(input.bootstrap?.prepareWorktree) });
    input.onBeforeTurnStart?.();
    await start({ createdAt: new Date().toISOString() });
  }
}
