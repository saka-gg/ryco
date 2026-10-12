import { Debouncer } from "@tanstack/react-pacer";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

export function isStateStorage(
  storage: Partial<StateStorage> | null | undefined,
): storage is StateStorage {
  return (
    storage !== null &&
    storage !== undefined &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  );
}

export function resolveStorage(storage: Partial<StateStorage> | null | undefined): StateStorage {
  return isStateStorage(storage) ? storage : createMemoryStorage();
}

export interface WriteScheduler {
  /** Runs `write` once the burst of calls settles; a later call replaces an earlier `write`. */
  readonly schedule: (write: () => void) => void;
  /** Runs the scheduled write now. */
  readonly flush: () => void;
}

export function createWriteScheduler(debounceMs: number = 300): WriteScheduler {
  const debounced = new Debouncer((write: () => void) => write(), { wait: debounceMs });
  return {
    schedule: (write) => debounced.maybeExecute(write),
    flush: () => debounced.flush(),
  };
}
