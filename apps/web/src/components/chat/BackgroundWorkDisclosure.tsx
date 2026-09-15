import { ChevronDownIcon } from "lucide-react";
import { memo, useEffect, useId, useRef, useState } from "react";
import type { BackgroundTask, BackgroundWork } from "@ryco/shared/backgroundWork";

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
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 px-3 py-2"
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

export function BackgroundWorkDisclosure(props: {
  work: BackgroundWork;
  connected: boolean;
  mutationReady: boolean;
  onStopTask: (task: BackgroundTask) => Promise<void>;
  onStopAll: () => void;
  stoppingAll: boolean;
  agentCount: number;
  waitingCount?: number | undefined;
  onOpenAgents?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!open || !props.connected || !props.work.tasks.some((task) => task.activeSince !== null))
      return;
    const tick = () => {
      if (document.hidden) return;
      const rows = new Map(props.work.tasks.map((task) => [task.id, task]));
      for (const node of listRef.current?.querySelectorAll<HTMLElement>(
        "[data-background-elapsed]",
      ) ?? []) {
        const task = rows.get(node.dataset.backgroundElapsed ?? "");
        if (task) node.textContent = elapsed(task, true);
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [open, props.connected, props.work.tasks]);
  return (
    <section
      aria-label="Background work"
      className="w-full min-w-0 rounded-lg border border-border/70 bg-popover/95 text-foreground shadow-sm"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium"
        >
          <ChevronDownIcon
            aria-hidden
            className={`size-3.5 shrink-0 ${open ? "rotate-180" : ""}`}
          />
          {props.work.tasks.length === 0 && props.work.detailsOmitted
            ? "Background work · details unavailable"
            : `${props.work.tasks.length} background ${props.work.tasks.length === 1 ? "task" : "tasks"}${props.work.detailsOmitted ? " · details limited" : ""}`}
        </button>
        {props.agentCount > 0 && props.onOpenAgents ? (
          <button
            type="button"
            onClick={props.onOpenAgents}
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            Agents ({props.agentCount}
            {props.waitingCount ? ` · ${props.waitingCount} waiting` : ""})
          </button>
        ) : null}
        <button
          type="button"
          onClick={props.onStopAll}
          disabled={props.stoppingAll || !props.connected || !props.mutationReady}
          className="shrink-0 text-xs hover:text-foreground disabled:text-muted-foreground/50"
        >
          {props.stoppingAll ? "Stopping…" : "Stop all"}
        </button>
      </div>
      {!props.connected ? (
        <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
          Connection lost · task status is unconfirmed
        </p>
      ) : null}
      <div hidden={!open}>
        <ul id={listId} ref={listRef} className="max-h-64 overflow-y-auto">
          {props.work.tasks.map((task) => (
            <TaskRow
              key={`${task.runtimeSessionId}:${task.id}:${task.attempt}`}
              task={task}
              connected={props.connected}
              mutationReady={props.mutationReady}
              onStop={props.onStopTask}
            />
          ))}
        </ul>
        {props.work.detailsOmitted ? (
          <p
            role="status"
            className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground"
          >
            Up to 100 task details are retained. Additional details are unavailable in this window;
            their current status is unknown.
          </p>
        ) : null}
      </div>
    </section>
  );
}
