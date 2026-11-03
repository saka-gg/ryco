import type {
  EnvironmentApi,
  ProjectFileChangeEvent,
  ProjectWatchFileFailureReason,
  ProjectWatchFileInput,
} from "@ryco/contracts";

/**
 * One connection's `projects.subscribeFileChanges` (`EnvironmentApi.projects`).
 * Clients call it only on nodes that advertise `projectFileWatch`.
 */
export type ProjectFileChangeSubscribe = NonNullable<
  EnvironmentApi["projects"]["subscribeFileChanges"]
>;

/**
 * A watch that stopped because its folder could not be watched (`unavailable`:
 * the folder is missing, or its watch stopped) tries again after this, doubling
 * per attempt up to the maximum. A watch outside the root or over a limit does
 * not: trying again cannot help.
 */
export const PROJECT_FILE_WATCH_INITIAL_RETRY_MS = 500;
export const PROJECT_FILE_WATCH_MAX_RETRY_MS = 8_000;
/** Attempts after a failure; an event from the node resets the count. */
export const PROJECT_FILE_WATCH_MAX_RETRY_ATTEMPTS = 5;

type Listener = (event: ProjectFileChangeEvent) => void;

interface SharedFileWatch {
  readonly listeners: Set<Listener>;
  /** The latest event, for a listener that joins later. */
  latest: ProjectFileChangeEvent | null;
  stop: () => void;
  retryTimer: ReturnType<typeof setTimeout> | null;
  attempts: number;
}

/** One map per connection, so a key is (environment, workspace, file). */
const watchesByConnection = new WeakMap<ProjectFileChangeSubscribe, Map<string, SharedFileWatch>>();

function readFailureReason(error: unknown): ProjectWatchFileFailureReason | null {
  const candidate = error as { readonly _tag?: unknown; readonly reason?: unknown } | null;
  if (candidate?._tag !== "ProjectWatchFileError") return null;
  const reason = candidate.reason;
  return reason === "outside-root" || reason === "unavailable" || reason === "limit"
    ? reason
    : null;
}

/**
 * Change notices for one workspace file on one connection. Every listener of
 * the same file shares one subscription (a node caps watches per connection):
 * the subscription closes with its last listener, and a listener that joins
 * later gets the latest event at once. The stream carries no content; a
 * listener that sees a version it does not hold reads the file again.
 */
export function watchProjectFile(
  subscribe: ProjectFileChangeSubscribe,
  input: ProjectWatchFileInput,
  listener: Listener,
): () => void {
  let watches = watchesByConnection.get(subscribe);
  if (watches === undefined) {
    watches = new Map();
    watchesByConnection.set(subscribe, watches);
  }
  const connectionWatches = watches;
  const key = `${input.cwd}\u0000${input.relativePath}`;
  const release = (watch: SharedFileWatch) => {
    if (!watch.listeners.delete(listener) || watch.listeners.size > 0) return;
    if (connectionWatches.get(key) === watch) connectionWatches.delete(key);
    if (watch.retryTimer !== null) clearTimeout(watch.retryTimer);
    watch.stop();
  };
  const existing = watches.get(key);
  if (existing !== undefined) {
    existing.listeners.add(listener);
    const latest = existing.latest;
    if (latest !== null) {
      // Not synchronously: the caller is still subscribing.
      void Promise.resolve().then(() => {
        if (existing.listeners.has(listener)) listener(latest);
      });
    }
    return () => release(existing);
  }

  const shared: SharedFileWatch = {
    listeners: new Set([listener]),
    latest: null,
    stop: () => undefined,
    retryTimer: null,
    attempts: 0,
  };
  const start = () => {
    let reason: ProjectWatchFileFailureReason | null = null;
    shared.stop = subscribe(
      { cwd: input.cwd, relativePath: input.relativePath },
      (event) => {
        shared.attempts = 0;
        shared.latest = event;
        for (const each of Array.from(shared.listeners)) each(event);
      },
      {
        classifyFailure: (error) => {
          reason = readFailureReason(error);
          return "failed";
        },
        onError: () => {
          if (
            reason !== "unavailable" ||
            shared.attempts >= PROJECT_FILE_WATCH_MAX_RETRY_ATTEMPTS
          ) {
            return;
          }
          const delay = Math.min(
            PROJECT_FILE_WATCH_INITIAL_RETRY_MS * 2 ** shared.attempts,
            PROJECT_FILE_WATCH_MAX_RETRY_MS,
          );
          shared.attempts += 1;
          shared.retryTimer = setTimeout(() => {
            shared.retryTimer = null;
            if (connectionWatches.get(key) === shared) start();
          }, delay);
        },
      },
    );
  };
  watches.set(key, shared);
  start();
  return () => release(shared);
}
