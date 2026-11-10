/**
 * The live half of the composer's dock: the thread's working subagents and its
 * background tasks. One segment of the dock's collapsed line, and, opened, the
 * agents' rows, each task with its own Stop, and Open Agents / Stop all.
 */
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { BackgroundTask } from "@ryco/shared/backgroundWork";

import { visibleSecondTicker } from "../../lib/perf/ticker";
import { cn } from "../../lib/utils";
import {
  AgentMonogramStack,
  AgentRosterProvider,
  AgentRow,
  AgentRowList,
} from "../agents/agentRoster";
import {
  DOCK_AGENT_ROW_LIMIT,
  type ThreadLiveWork,
  type ThreadLiveWorkSummary,
} from "./threadLiveWork";

function elapsed(task: BackgroundTask, connected: boolean): string {
  const start = task.activeSince ? Date.parse(task.activeSince) : NaN;
  const end = connected && task.status !== "idle" ? Date.now() : Date.parse(task.updatedAt);
  const active = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
  const seconds = Math.max(0, Math.floor((task.elapsedMs + active) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const TaskRow = memo(function TaskRow({
  task,
  connected,
  mutationReady,
  onStop,
}: {
  task: BackgroundTask;
  connected: boolean;
  mutationReady: boolean;
  onStop: (task: BackgroundTask) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const requestVersion = useRef(0);
  const pendingRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      requestVersion.current++;
      pendingRef.current = false;
      setPending(false);
      setError("Stop has not been confirmed. You can retry.");
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [pending]);
  const stop = async () => {
    if (
      pendingRef.current ||
      !connected ||
      !mutationReady ||
      !task.canStop ||
      !task.runtimeSessionId
    )
      return;
    pendingRef.current = true;
    const version = ++requestVersion.current;
    setPending(true);
    setError(null);
    try {
      await onStop(task);
      // RPC acceptance is not task completion. Lifecycle events remove the row.
    } catch (cause) {
      if (!mounted.current || version !== requestVersion.current) return;
      pendingRef.current = false;
      setPending(false);
      setError(cause instanceof Error ? cause.message : "Could not stop this task.");
    }
  };
  return (
    <li
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/65 px-3 py-1.5"
      data-background-task={task.id}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-foreground" title={task.title}>
          {task.title}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {connected
            ? task.status === "idle"
              ? "Paused / idle"
              : task.status === "waiting"
                ? "Waiting"
                : task.status === "pending"
                  ? "Pending"
                  : "Running"
            : "Status unconfirmed"}
          <span className="ml-2 tabular-nums" data-background-elapsed={task.id}>
            {elapsed(task, connected)}
          </span>
        </p>
      </div>
      <button
        type="button"
        onClick={() => void stop()}
        disabled={
          pending || !connected || !mutationReady || !task.canStop || !task.runtimeSessionId
        }
        title={!task.canStop ? "This provider session cannot stop individual tasks" : undefined}
        aria-label={`Stop ${task.title}`}
        className="shrink-0 rounded px-2 py-1 text-xs hover:bg-muted disabled:cursor-default disabled:text-muted-foreground/50"
      >
        {pending ? "Stopping…" : "Stop"}
      </button>
      {error ? (
        <p role="alert" className="w-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
});

/** One piece of the dock's collapsed line. */
export interface DockHeaderSegment {
  readonly key: string;
  readonly node: ReactNode;
}

/** Monograms shown on the collapsed line. */
const HEAD_MONOGRAMS = 3;
const LINK_BUTTON =
  "shrink-0 rounded-sm text-[11.5px] whitespace-nowrap text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:text-muted-foreground/50 disabled:hover:text-muted-foreground/50";

/**
 * The live work's segments of the dock's collapsed line: who works, how many
 * tasks run. Each is one unbreakable piece; the dock sets them apart.
 */
export function dockLiveWorkSegments(
  liveWork: ThreadLiveWork,
  summary: ThreadLiveWorkSummary,
): DockHeaderSegment[] {
  const segments: DockHeaderSegment[] = [];
  if (summary.workingCount > 0) {
    const shown = summary.workingAgents.slice(0, HEAD_MONOGRAMS);
    segments.push({
      key: "agents",
      node: (
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          {shown.length > 0 ? (
            <AgentRosterProvider model={liveWork.agentPanelModel}>
              <AgentMonogramStack agents={shown} max={HEAD_MONOGRAMS} total={shown.length} />
            </AgentRosterProvider>
          ) : null}
          <span>
            <b className="font-semibold text-foreground">
              {summary.workingCount} {summary.workingCount === 1 ? "agent" : "agents"} working
            </b>
            {summary.agentCount > summary.workingCount ? ` of ${summary.agentCount}` : null}
            {summary.waitingCount > 0 ? ` · ${summary.waitingCount} waiting` : null}
          </span>
        </span>
      ),
    });
  }
  const label = summary.tasksLabel ?? summary.idleLabel;
  if (label) {
    segments.push({
      key: "tasks",
      node: (
        <span
          className={cn(
            "shrink-0 whitespace-nowrap",
            segments.length === 0 && "font-semibold text-foreground",
          )}
        >
          {label}
        </span>
      ),
    });
  }
  return segments;
}

/**
 * The opened dock's live work. Task rows stay mounted while the dock is
 * closed, so a pending Stop keeps its state; agent rows mount only when open.
 */
export function DockLiveWorkSection(props: {
  readonly liveWork: ThreadLiveWork;
  readonly summary: ThreadLiveWorkSummary;
  readonly open: boolean;
}) {
  const { liveWork, summary, open } = props;
  const { work, connected } = liveWork;
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!open || !connected || !work.tasks.some((task) => task.activeSince !== null)) return;
    // The shared second clock: one timer for every elapsed label, paused while the page is hidden.
    return visibleSecondTicker.subscribe(() => {
      const rows = new Map(work.tasks.map((task) => [task.id, task]));
      for (const node of listRef.current?.querySelectorAll<HTMLElement>(
        "[data-background-elapsed]",
      ) ?? []) {
        const task = rows.get(node.dataset.backgroundElapsed ?? "");
        if (task) node.textContent = elapsed(task, true);
      }
    });
  }, [open, connected, work.tasks]);
  const agents = summary.workingAgents.slice(0, DOCK_AGENT_ROW_LIMIT);
  const moreAgents = summary.workingCount - agents.length;
  const hasAgents = liveWork.agentPanelModel.hasAgents;
  return (
    <section aria-label="Background work" hidden={!open} data-testid="dock-live-work">
      {open && agents.length > 0 ? (
        <div className="delegation-dock-rise border-t border-border/65 px-1.5 py-1">
          <AgentRosterProvider model={liveWork.agentPanelModel} onOpenAgent={liveWork.onOpenAgent}>
            <AgentRowList>
              {agents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} density="compact" />
              ))}
            </AgentRowList>
          </AgentRosterProvider>
        </div>
      ) : null}
      <ul ref={listRef} className="max-h-64 overflow-y-auto">
        {work.tasks.map((task) => (
          <TaskRow
            key={`${task.runtimeSessionId}:${task.id}:${task.attempt}`}
            task={task}
            connected={connected}
            mutationReady={liveWork.mutationReady}
            onStop={liveWork.onStopTask}
          />
        ))}
      </ul>
      {work.detailsOmitted ? (
        <p
          role="status"
          className="border-t border-border/65 px-3 py-1.5 text-[11.5px] text-muted-foreground"
        >
          Up to 100 task details are retained. Additional details are unavailable in this window;
          their current status is unknown.
        </p>
      ) : null}
      <div className="flex items-center gap-3 border-t border-border/65 px-3 py-1.5 text-[11.5px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" role={connected ? undefined : "status"}>
          {!connected
            ? "Connection lost · task status is unconfirmed"
            : moreAgents > 0
              ? `${moreAgents} more working in the Agents panel`
              : (summary.tasksLabel ?? summary.idleLabel)}
        </span>
        {hasAgents ? (
          <button type="button" onClick={liveWork.onOpenAgents} className={LINK_BUTTON}>
            Open Agents
          </button>
        ) : null}
        {summary.offersStopAll ? (
          <button
            type="button"
            onClick={liveWork.onStopAll}
            disabled={liveWork.stoppingAll || !connected || !liveWork.mutationReady}
            className={cn(LINK_BUTTON, "text-foreground/85")}
          >
            {liveWork.stoppingAll ? "Stopping…" : "Stop all"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
