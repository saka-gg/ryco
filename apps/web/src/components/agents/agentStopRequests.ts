/**
 * Stops sent for native agents, shared by every control that offers one (a
 * roster row, the agent's detail header, the crown and the Agents tab), so
 * they agree on what is pending and each request is reported once, also after
 * the control that sent it is gone.
 */
import { STOP_UNCONFIRMED_MS } from "./agentStop.logic";

/** How a request's outcome is reported; the node accepting it is not reported. */
export interface StopRequestReports {
  /** The agent still runs once the request timed out, and a control for it is shown. */
  readonly onUnconfirmed: () => void;
  /** The node refused the stop or the request failed, even after the timeout. */
  readonly onFailed: (cause: unknown) => void;
}

export interface StopRequestRegistry {
  /** Whether a stop for `key` waits to be confirmed. */
  readonly isPending: (key: string) => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  /** Counts a control for `key` as shown until the returned function runs. */
  readonly watch: (key: string) => () => void;
  /** Sends a stop for `key` unless one is pending; returns whether it was sent. */
  readonly start: (key: string, send: () => Promise<void>, reports: StopRequestReports) => boolean;
  /** Forgets every request; for tests. */
  readonly clear: () => void;
}

interface StopRequest {
  pending: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * A stop stays pending until its agent settles, which unmounts its controls,
 * or until `timeoutMs` passes. A timed-out request is reported only while a
 * control for it is shown: with none, its agent has most likely settled. A
 * failure is always reported, unless a retry of the same stop superseded it.
 */
export function createStopRequestRegistry(timeoutMs: number): StopRequestRegistry {
  const requests = new Map<string, StopRequest>();
  const watchers = new Map<string, number>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    isPending: (key) => requests.get(key)?.pending === true,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    watch(key) {
      watchers.set(key, (watchers.get(key) ?? 0) + 1);
      let watching = true;
      return () => {
        if (!watching) return;
        watching = false;
        const count = (watchers.get(key) ?? 1) - 1;
        if (count > 0) watchers.set(key, count);
        else watchers.delete(key);
      };
    },
    start(key, send, reports) {
      if (requests.get(key)?.pending) return false;
      // Replaces a timed-out request whose reply is still out: its outcome is old news.
      const request: StopRequest = { pending: true, settled: false, timer: undefined };
      requests.set(key, request);
      request.timer = setTimeout(() => {
        if (requests.get(key) !== request) return;
        request.pending = false;
        if (request.settled) requests.delete(key);
        notify();
        if (watchers.has(key)) reports.onUnconfirmed();
      }, timeoutMs);
      notify();

      let sent: Promise<void>;
      try {
        sent = send();
      } catch (cause) {
        sent = Promise.reject(cause);
      }
      sent.then(
        () => {
          request.settled = true;
          if (!request.pending && requests.get(key) === request) requests.delete(key);
        },
        (cause: unknown) => {
          request.settled = true;
          if (requests.get(key) !== request) return;
          clearTimeout(request.timer);
          requests.delete(key);
          if (request.pending) {
            request.pending = false;
            notify();
          }
          reports.onFailed(cause);
        },
      );
      return true;
    },
    clear() {
      for (const request of requests.values()) clearTimeout(request.timer);
      requests.clear();
      watchers.clear();
      notify();
    },
  };
}

/** The app's one registry. */
export const agentStopRequests = createStopRequestRegistry(STOP_UNCONFIRMED_MS);
