import { applyTaskToggles, type TaskToggle } from "./markdownTasks";

/**
 * Saving description task toggles. A toggle rewrites the whole body, so each
 * save starts from the body the host has right now (never the cached one, which
 * can be minutes old), and saves for one pull request run one at a time: clicks
 * made while a save is in flight queue up and go out together in the next one,
 * built on the body the previous save left. Toggles stay pending (and shown)
 * until the save that carries them lands, so an earlier save's result never
 * unticks a later click.
 */

export interface DescriptionTaskHost {
  /** The description as the host has it now, bypassing caches. */
  readonly readFresh: () => Promise<string>;
  /** Saves the whole description; resolves once the host has it. */
  readonly save: (body: string) => Promise<void>;
}

export interface DescriptionTaskState {
  /** Toggles not yet saved, oldest first; show them over the cached body. */
  readonly pending: ReadonlyArray<TaskToggle>;
  readonly error: string | null;
}

export interface DescriptionTaskQueue {
  readonly snapshot: (key: string) => DescriptionTaskState;
  readonly subscribe: (key: string, listener: () => void) => () => void;
  /** Queues `toggle` and starts saving unless a save for `key` is in flight. */
  readonly toggle: (key: string, toggle: TaskToggle, host: DescriptionTaskHost) => void;
}

export const DESCRIPTION_CHANGED_MESSAGE =
  "The description changed since it loaded, so the task wasn’t saved. Check it again.";

const IDLE: DescriptionTaskState = { pending: [], error: null };

interface Entry {
  state: DescriptionTaskState;
  host: DescriptionTaskHost;
  draining: boolean;
  readonly listeners: Set<() => void>;
}

export function createDescriptionTaskQueue(
  describeFailure: (error: unknown) => string,
): DescriptionTaskQueue {
  const entries = new Map<string, Entry>();

  function publish(entry: Entry, state: DescriptionTaskState): void {
    entry.state = state;
    for (const listener of entry.listeners) listener();
  }

  function prune(key: string, entry: Entry): void {
    if (entry.draining || entry.listeners.size > 0 || entry.state.pending.length > 0) return;
    if (entries.get(key) === entry) entries.delete(key);
  }

  async function drain(key: string, entry: Entry): Promise<void> {
    entry.draining = true;
    try {
      while (entry.state.pending.length > 0) {
        let outcome: { readonly settled: number; readonly rejected: number };
        try {
          const current = await entry.host.readFresh();
          // Everything clicked so far, including clicks made during the read.
          const batch = entry.state.pending;
          const { body, rejected } = applyTaskToggles(current, batch);
          if (body !== current) await entry.host.save(body);
          outcome = { settled: batch.length, rejected };
        } catch (error) {
          // None of the queue is known to be saved: drop it all, so the
          // boxes show the host's state again.
          publish(entry, { pending: [], error: describeFailure(error) });
          return;
        }
        publish(entry, {
          pending: entry.state.pending.slice(outcome.settled),
          error: outcome.rejected > 0 ? DESCRIPTION_CHANGED_MESSAGE : entry.state.error,
        });
      }
    } finally {
      entry.draining = false;
      prune(key, entry);
    }
  }

  return {
    snapshot: (key) => entries.get(key)?.state ?? IDLE,
    subscribe: (key, listener) => {
      let entry = entries.get(key);
      if (!entry) {
        entry = { state: IDLE, host: NO_HOST, draining: false, listeners: new Set() };
        entries.set(key, entry);
      }
      const subscribed = entry;
      subscribed.listeners.add(listener);
      return () => {
        subscribed.listeners.delete(listener);
        prune(key, subscribed);
      };
    },
    toggle: (key, toggle, host) => {
      let entry = entries.get(key);
      if (!entry) {
        entry = { state: IDLE, host, draining: false, listeners: new Set() };
        entries.set(key, entry);
      }
      entry.host = host;
      publish(entry, { pending: [...entry.state.pending, toggle], error: null });
      if (!entry.draining) void drain(key, entry);
    },
  };
}

const NO_HOST: DescriptionTaskHost = {
  readFresh: () => Promise.reject(new Error("Nothing to save.")),
  save: () => Promise.reject(new Error("Nothing to save.")),
};
