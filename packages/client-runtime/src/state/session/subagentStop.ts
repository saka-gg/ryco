import type { ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { RuntimeSessionId } from "@ryco/contracts/base-schemas";
import type { OrchestrationStopBackgroundTaskInput } from "@ryco/contracts/orchestration";

import { isActiveSubagentStatus, type RuntimeSubagent } from "./subagentRuntime.ts";

/**
 * Which native subagents a client may stop on their own, with what identity,
 * and how a stop is followed until the agent settles: what is pending, when it
 * counts as unconfirmed, and what a failure says. Shared by web's Stop
 * controls and the phone's agents sheet. Kept out of the state/session barrel:
 * the subagent fold sits on the web app's boot graph, and only lazily loaded
 * Stop controls need this.
 */

/** How long a stop the node accepted may go unconfirmed before Stop is offered again. */
export const STOP_UNCONFIRMED_MS = 20_000;

/** The exact task a stop targets; the node refuses it once the runtime or attempt moved on. */
export interface SubagentStopIdentity {
  readonly taskId: string;
  readonly runtimeSessionId: string;
  readonly attempt: number;
}

/** What a surface needs to offer Stop on agent rows; the app owns gating and the request. */
export interface SubagentStopAction {
  /** The thread whose agents this stops. */
  readonly threadRef: ScopedThreadRef;
  /** The thread's current provider runtime: agents an earlier runtime reported can't be stopped. */
  readonly runtimeSessionId: string | null;
  /** Why Stop is shown but can't be used right now, or null when it can. */
  readonly unavailableReason: string | null;
  /**
   * Resolves once the node accepted the stop. The row settles when the
   * provider reports the task stopped, never through a turn interrupt.
   */
  readonly stop: (identity: SubagentStopIdentity) => Promise<void>;
}

/**
 * The identity to stop `agent` with, or null when it can't be stopped on its
 * own. Only direct subagents qualify: stopping a workflow coordinator ends its
 * whole run, and workflow members are slots synthesized from workflow
 * progress, not provider tasks (their attempt is the workflow's retry count).
 * Older nodes flag those members stoppable, so this kind check is the guard.
 * The agent must also be active, flagged stoppable by its provider and
 * reported by the thread's current runtime; the node re-checks all of it.
 * Claude never stamps an attempt on agent tasks and expects 0 for them.
 */
export function subagentStopIdentity(
  agent: RuntimeSubagent,
  currentRuntimeSessionId: string | null,
): SubagentStopIdentity | null {
  if (
    agent.kind !== "subagent" ||
    !isActiveSubagentStatus(agent.status) ||
    !agent.canStop ||
    agent.runtimeSessionId === null ||
    agent.runtimeSessionId !== currentRuntimeSessionId
  ) {
    return null;
  }
  return {
    taskId: agent.id,
    runtimeSessionId: agent.runtimeSessionId,
    attempt: agent.attempt ?? 0,
  };
}

/**
 * The node request that stops exactly `identity`'s task: the node refuses it
 * once that task's runtime or attempt moved on, and it never interrupts the turn.
 */
export function subagentStopRequest(
  threadId: ThreadId,
  identity: SubagentStopIdentity,
): OrchestrationStopBackgroundTaskInput {
  return {
    threadId,
    taskId: identity.taskId,
    expected: {
      runtimeSessionId: RuntimeSessionId.make(identity.runtimeSessionId),
      attempt: identity.attempt,
    },
  };
}

/**
 * What a rejected stop says. The node's classified reasons get agent copy (a
 * stale identity is refused as stop-failed); anything else keeps its message.
 */
export function describeSubagentStopFailure(cause: unknown): string {
  const failure = cause as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
    readonly message?: unknown;
  } | null;
  if (failure?._tag === "OrchestrationStopBackgroundTaskError") {
    switch (failure.reason) {
      case "unsupported":
        return "This provider can't stop a single agent.";
      case "session-not-found":
        return "This agent's session has ended.";
      case "stop-failed":
        return "The agent did not stop. Try again.";
    }
  }
  return typeof failure?.message === "string" && failure.message.trim().length > 0
    ? failure.message
    : "Could not stop this agent.";
}

/** One activation of one task of one thread: a new runtime or attempt is a new stop. */
export function subagentStopKey(
  threadRef: ScopedThreadRef,
  identity: SubagentStopIdentity,
): string {
  return `${threadRef.environmentId}:${threadRef.threadId}:${identity.runtimeSessionId}:${identity.taskId}:${identity.attempt}`;
}

// Stops in flight, shared by every control that offers one (web's roster row,
// detail header, crown and Agents tab; the phone's agents sheet), so they agree
// on what is pending and each request is reported once, also after the control
// that sent it is gone. Each app keeps one registry.

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
          if (request.timer !== undefined) clearTimeout(request.timer);
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
      for (const request of requests.values()) {
        if (request.timer !== undefined) clearTimeout(request.timer);
      }
      requests.clear();
      watchers.clear();
      notify();
    },
  };
}
