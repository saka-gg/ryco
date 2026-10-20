import type { LocalTaskChange, LocalTaskChangePosition } from "@ryco/contracts";
import { Effect, Queue, Stream } from "effect";

/** The most changed tasks a listener holds before it is told to read everything instead. */
export const LOCAL_TASK_CHANGE_BACKLOG = 256;

/**
 * The node's task changes, for the clients showing tasks. A change only says which task to read
 * again, so a listener holds each changed task once (a deletion wins) instead of a queue of
 * events: one that falls behind (a stalled connection) holds at most `backlog` tasks, and past
 * that just the word to read everything. Each listener's first change, sent once it listens, is
 * that word: nothing that changed before can be missed. The word carries the position it covers
 * (`{ position }`), counting every change published before it was sent; a change is published
 * only after its write committed, so a read stamped at or past that position holds them all.
 */
export interface LocalTaskChangeFeed {
  readonly publish: (taskId: string, deleted?: boolean) => Effect.Effect<void>;
  /** Where the changes stand now; read it before reading tasks to stamp the read. */
  readonly position: Effect.Effect<LocalTaskChangePosition>;
  readonly changes: Stream.Stream<LocalTaskChange>;
}

interface Listener {
  /** Changed task ids, and whether the task was deleted. */
  readonly pending: Map<string, boolean>;
  resync: boolean;
  readonly wake: Queue.Queue<void>;
}

export const makeLocalTaskChangeFeed = (
  backlog = LOCAL_TASK_CHANGE_BACKLOG,
): Effect.Effect<LocalTaskChangeFeed> =>
  Effect.sync(() => {
    const listeners = new Set<Listener>();
    // Names this feed: a restarted node has another, so its positions are never compared with
    // those from before.
    const feed = crypto.randomUUID();
    let sequence = 0;

    const publish = (taskId: string, deleted = false) =>
      Effect.sync(() => {
        sequence += 1;
        for (const listener of listeners) {
          if (!listener.resync) {
            listener.pending.set(taskId, deleted || (listener.pending.get(taskId) ?? false));
            if (listener.pending.size > backlog) {
              listener.resync = true;
              listener.pending.clear();
            }
          }
          Queue.offerUnsafe(listener.wake, undefined);
        }
      });

    const drain = (listener: Listener): ReadonlyArray<LocalTaskChange> => {
      if (listener.resync) {
        listener.resync = false;
        listener.pending.clear();
        // Taken now, not when the listener registered: the changes published until now are folded
        // into this word, and only this position covers them.
        return [{ position: { feed, sequence } }];
      }
      const changes = [...listener.pending].map(([taskId, deleted]) =>
        deleted ? { taskId, deleted } : { taskId },
      );
      listener.pending.clear();
      return changes;
    };

    const changes = Stream.unwrap(
      Effect.gen(function* () {
        const wake = yield* Queue.sliding<void>(1);
        const listener: Listener = { pending: new Map(), resync: true, wake };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            listeners.add(listener);
            Queue.offerUnsafe(wake, undefined);
          }),
          () => Effect.sync(() => listeners.delete(listener)),
        );
        return Stream.fromQueue(wake).pipe(
          Stream.flatMap(() => Stream.fromIterable(drain(listener))),
        );
      }),
    );

    const position = Effect.sync(() => ({ feed, sequence }));

    return { publish, position, changes };
  });
