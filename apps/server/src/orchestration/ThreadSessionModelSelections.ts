/**
 * ThreadSessionModelSelectionsService - in-memory record of the model selection each thread's
 * provider session runs with.
 *
 * A chat's stored selection (`thread.modelSelection`) is what its clients picked last; a client
 * stores a pick when it is made, and the session takes it at the next turn. What the session
 * runs is recorded here: the provider command reactor writes the selection a turn applied, and
 * reads it to decide whether the next turn's selection restarts the session. The engine reads
 * the same record to refuse a turn start whose restart would end the session's background
 * work (`requireNoBackgroundWorkForModelSwitch`). Without a record (after a restart, or before
 * the thread's first turn here) the thread's stored selection stands in: a fresh process holds
 * no live runtime whose work a restart could end.
 *
 * @module ThreadSessionModelSelectionsService
 */
import type { ModelSelection, ThreadId } from "@ryco/contracts";
import { Context, Effect, Layer } from "effect";

export class ThreadSessionModelSelectionsService extends Context.Service<
  ThreadSessionModelSelectionsService,
  {
    /** The selection the thread's session last applied in this process, if any. */
    readonly get: (threadId: ThreadId) => ModelSelection | undefined;
    readonly set: (threadId: ThreadId, modelSelection: ModelSelection) => void;
    /** Another owner (a context handoff) replaced the session: what it runs is unknown here. */
    readonly forget: (threadId: ThreadId) => void;
  }
>()("ryco/orchestration/ThreadSessionModelSelectionsService") {}

export function make(): ThreadSessionModelSelectionsService["Service"] {
  const selections = new Map<ThreadId, ModelSelection>();
  return {
    get: (threadId) => selections.get(threadId),
    set: (threadId, modelSelection) => {
      selections.set(threadId, modelSelection);
    },
    forget: (threadId) => {
      selections.delete(threadId);
    },
  };
}

export const layer = Layer.effect(ThreadSessionModelSelectionsService, Effect.sync(make));
