/**
 * ThreadBackgroundLivenessService - in-memory per-thread background liveness
 * for the sidebar status pill.
 *
 * The turn can settle while native background work runs on (subagent fleets,
 * workflow runs, Monitor watch loops); the shell previously showed nothing.
 * Ingestion records task lifecycle transitions and the shell query reads the
 * derived state at mapping time — no persistence, no migration. After a
 * server restart the registry is empty until new task events arrive, which
 * matches reality: orphaned background work is not live.
 *
 * All live background work presents as "working", including background
 * shells and monitor tasks that outlive the foreground turn.
 *
 * @module ThreadBackgroundLivenessService
 */
import { INERT_TASK_TYPES, MONITOR_TASK_TYPES } from "@ryco/shared/taskClassification";
import { Context, Effect, Layer } from "effect";

export type ThreadBackgroundLiveness = "working" | "monitoring" | null;

interface ThreadLivenessState {
  readonly agents: Set<string>;
  readonly monitors: Set<string>;
}

// Classification sets are the @ryco/shared/taskClassification copies
// (MONITOR_TASK_TYPES: watch loops — monitor tasks plus background shells,
// which in practice are PR babysitting/log tails since pacing sleeps
// complete inside the turn; INERT_TASK_TYPES: plan-mode bookkeeping) so this
// registry, ingestion's agentKind stamp, and the client fold can never
// drift apart.

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);

export class ThreadBackgroundLivenessService extends Context.Service<
  ThreadBackgroundLivenessService,
  {
    /**
     * Feed one task lifecycle transition. taskType may be absent on
     * synthesized rows (workflow members, Codex children) — those count as
     * agents. agentId marks a task launched from inside a subagent: its
     * internal shells are covered by the owning agent's liveness, but a
     * NESTED AGENT (agentId + agent-flavored taskType) still counts — it
     * can outlive its parent and must keep the thread Working.
     */
    readonly recordTaskLiveness: (input: {
      readonly threadId: string;
      readonly taskId: string;
      readonly taskType: string | undefined;
      readonly status: string | undefined;
      readonly kind: "started" | "progress" | "updated" | "completed";
      readonly agentId?: string | undefined;
      readonly attempt?: number | undefined;
      readonly parentAgentId?: string | undefined;
      /**
       * The runtime that reported the transition (null for a runtime without an id). A report
       * from another runtime than the thread's earlier reports means that runtime was replaced:
       * its work died with it, so the thread's earlier liveness is dropped first.
       */
      readonly runtimeSessionId?: string | null | undefined;
    }) => void;

    /** Session death orphans all of a thread's background work. */
    readonly clearThreadLiveness: (threadId: string) => void;

    /**
     * Any live agent, background shell, or monitor task keeps the thread working.
     */
    readonly getThreadBackgroundLiveness: (threadId: string) => ThreadBackgroundLiveness;

    /**
     * The task ids that keep the thread working; empty exactly when its liveness is null. Given
     * a runtime, only that runtime's tasks: tasks a replaced runtime reported are dead, even
     * though its late terminal events are dropped as stale and never clear them.
     */
    readonly listLiveTaskIds: (
      threadId: string,
      runtimeSessionId?: string | null,
    ) => ReadonlyArray<string>;

    /** Threads with at least one live agent or watch loop (graceful-shutdown hints). */
    readonly listLiveThreadIds: () => ReadonlyArray<string>;
  }
>()("ryco/orchestration/ThreadBackgroundLiveness/ThreadBackgroundLivenessService") {}

interface TaskLivenessHistory {
  taskType: string | undefined;
  parentAgentId: string | undefined;
  terminal: boolean;
  attempt: number | undefined;
}

export function make(): ThreadBackgroundLivenessService["Service"] {
  const stateByThreadId = new Map<string, ThreadLivenessState>();
  // Session-scoped history prevents delayed starts/status patches from reviving
  // completed tasks and retains classification on sparse updates.
  const history = new Map<string, Map<string, TaskLivenessHistory>>();
  // The runtime whose reports the thread's state and history hold (see `recordTaskLiveness`).
  const runtimeByThreadId = new Map<string, string | null>();

  const clearThread = (threadId: string) => {
    stateByThreadId.delete(threadId);
    history.delete(threadId);
    runtimeByThreadId.delete(threadId);
  };

  const stateFor = (threadId: string): ThreadLivenessState => {
    const existing = stateByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const created: ThreadLivenessState = { agents: new Set(), monitors: new Set() };
    stateByThreadId.set(threadId, created);
    return created;
  };

  // Classification is per-transition, not sticky: a task first seen without
  // a taskType may later reveal itself as a shell, become inert, or turn out
  // to be agent-owned. Every path drops any prior entry for the taskId so a
  // stale bucket assignment can't pin the thread's status.
  const drop = (threadId: string, taskId: string) => {
    const state = stateByThreadId.get(threadId);
    if (!state) {
      return;
    }
    state.agents.delete(taskId);
    state.monitors.delete(taskId);
    if (state.agents.size === 0 && state.monitors.size === 0) {
      stateByThreadId.delete(threadId);
    }
  };

  return {
    recordTaskLiveness: (input) => {
      if (input.runtimeSessionId !== undefined) {
        if (
          runtimeByThreadId.has(input.threadId) &&
          runtimeByThreadId.get(input.threadId) !== input.runtimeSessionId
        ) {
          clearThread(input.threadId);
        }
        runtimeByThreadId.set(input.threadId, input.runtimeSessionId);
      }
      const tasks = history.get(input.threadId) ?? new Map<string, TaskLivenessHistory>();
      const previous = tasks.get(input.taskId);
      if (
        input.attempt !== undefined &&
        previous?.attempt !== undefined &&
        input.attempt < previous.attempt
      )
        return;
      const newAttempt =
        input.attempt !== undefined &&
        previous?.attempt !== undefined &&
        input.attempt > previous.attempt;
      if (previous?.terminal && !newAttempt) return;
      const taskType = input.taskType ?? previous?.taskType;
      const parentAgentId = input.parentAgentId ?? previous?.parentAgentId;
      const terminalEvent =
        input.kind === "completed" ||
        (input.status !== undefined && TERMINAL_STATUSES.has(input.status));
      tasks.set(input.taskId, {
        taskType,
        parentAgentId,
        terminal: terminalEvent,
        attempt: input.attempt ?? previous?.attempt,
      });
      history.set(input.threadId, tasks);
      const parent = parentAgentId ? tasks.get(parentAgentId) : undefined;
      if (parent?.taskType === "local_workflow" && parent.terminal) {
        tasks.get(input.taskId)!.terminal = true;
        drop(input.threadId, input.taskId);
        return;
      }
      if (taskType === "local_workflow" && terminalEvent) {
        for (const [memberId, member] of tasks) {
          if (member.parentAgentId === input.taskId) {
            member.terminal = true;
            drop(input.threadId, memberId);
          }
        }
      }

      if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) {
        drop(input.threadId, input.taskId);
        return;
      }
      // A subagent's internal non-agent work (its own shells/monitors) is
      // covered by the owning agent's liveness. Nested agents fall through:
      // they can outlive their parent. Blank/whitespace agentId counts as
      // absent — same semantics as classifyTaskAgentKind, so a stamped
      // "background" row is never dropped here as agent-owned.
      const agentOwned = input.agentId !== undefined && input.agentId.trim().length > 0;
      if (agentOwned && (taskType === undefined || MONITOR_TASK_TYPES.has(taskType))) {
        drop(input.threadId, input.taskId);
        return;
      }

      // Idle counts as not-live: a resting (resumable) Codex child isn't
      // doing anything, and an all-idle fleet must not pin Working.
      const terminal =
        input.kind === "completed" ||
        input.status === "idle" ||
        (input.status !== undefined && TERMINAL_STATUSES.has(input.status));
      if (terminal) {
        drop(input.threadId, input.taskId);
        return;
      }

      // Status-free progress is a description tick, not a restart. A delayed
      // progress event after idle must not put the task back in the live set.
      if (input.kind !== "started" && input.status === undefined) {
        const existing = stateByThreadId.get(input.threadId);
        const stillLive =
          existing !== undefined &&
          (existing.agents.has(input.taskId) || existing.monitors.has(input.taskId));
        if (!stillLive) {
          return;
        }
      }

      drop(input.threadId, input.taskId);
      const state = stateFor(input.threadId);
      const bucket =
        taskType !== undefined && MONITOR_TASK_TYPES.has(taskType) ? state.monitors : state.agents;
      bucket.add(input.taskId);
    },

    clearThreadLiveness: clearThread,

    // `drop` prunes empty threads, so every key has live work.
    listLiveThreadIds: () => [...stateByThreadId.keys()],

    listLiveTaskIds: (threadId, runtimeSessionId) => {
      const state = stateByThreadId.get(threadId);
      if (!state) return [];
      if (
        runtimeSessionId !== undefined &&
        runtimeByThreadId.has(threadId) &&
        runtimeByThreadId.get(threadId) !== runtimeSessionId
      ) {
        return [];
      }
      return [...state.agents, ...state.monitors];
    },

    getThreadBackgroundLiveness: (threadId) => {
      const state = stateByThreadId.get(threadId);
      if (!state) {
        return null;
      }
      if (state.agents.size > 0 || state.monitors.size > 0) {
        return "working";
      }
      return null;
    },
  };
}

export const layer = Layer.effect(ThreadBackgroundLivenessService, Effect.sync(make));
