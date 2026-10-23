/**
 * Stop for one native agent: a square button revealed on a roster row, or a
 * labeled one in the agent's detail header. Loaded only with the surfaces that
 * offer it (the Agents panel and the crown), never with the chat route.
 */
import {
  subagentStopIdentity,
  type SubagentStopAction,
  type SubagentStopIdentity,
} from "@ryco/client-runtime/state/session/subagentStop";
import { useEffect, useEffectEvent, useRef, useState, type ReactElement } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import type { RuntimeSubagent } from "../../threadWorkspaceViewModel";
import { useAgentRowIdentity, type AgentRowDecorator } from "./agentRoster";
import {
  describeSubagentStopFailure,
  STOP_UNCONFIRMED_MS,
  subagentStopKey,
} from "./agentStop.logic";

type AgentStopVariant = "icon" | "labeled";

/** Stop for `agent` when it can be stopped on its own; nothing otherwise. */
export function AgentStopButton({
  agent,
  action,
  variant,
}: {
  agent: RuntimeSubagent;
  action: SubagentStopAction;
  variant: AgentStopVariant;
}) {
  const identity = subagentStopIdentity(agent, action.runtimeSessionId);
  // A new runtime or attempt is a new stop, so it starts out not pending.
  return identity ? (
    <AgentStopControl
      key={subagentStopKey(identity)}
      agent={agent}
      identity={identity}
      action={action}
      variant={variant}
    />
  ) : null;
}

/**
 * Wraps a roster row so its Stop sits beside it rather than inside it (an
 * opening row is a button). The wrapper is there for every row, so a row never
 * remounts when it becomes stoppable; on hover or focus, Stop takes the place
 * of the row's time and status, and on touch it stays in view.
 */
function AgentStopRow({
  agent,
  row,
  action,
}: {
  agent: RuntimeSubagent;
  row: ReactElement;
  action: SubagentStopAction;
}) {
  const stoppable = subagentStopIdentity(agent, action.runtimeSessionId) !== null;
  return (
    <div
      className={cn(
        "group/agent-row relative",
        stoppable &&
          // The opening row keeps its hover tint while the pointer is on Stop.
          "[&:hover>button[data-agent-row]]:bg-accent/35 [&_[data-agent-row-aside]]:transition-opacity [&:focus-within_[data-agent-row-aside]]:opacity-0 [&:hover_[data-agent-row-aside]]:opacity-0 pointer-coarse:[&_[data-agent-row-aside]]:opacity-0",
      )}
    >
      {row}
      {stoppable ? (
        <span className="pointer-events-none absolute top-1/2 right-1.5 flex -translate-y-1/2 opacity-0 transition-opacity group-focus-within/agent-row:pointer-events-auto group-focus-within/agent-row:opacity-100 group-hover/agent-row:pointer-events-auto group-hover/agent-row:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100">
          <AgentStopButton agent={agent} action={action} variant="icon" />
        </span>
      ) : null}
    </div>
  );
}

/** Roster rows offer Stop through `action`; without one they stay as they are. */
export function makeAgentStopDecorator(
  action: SubagentStopAction | null,
): AgentRowDecorator | null {
  if (!action) return null;
  return (agent, row) => <AgentStopRow agent={agent} row={row} action={action} />;
}

/**
 * The node accepting a stop is not the agent stopping: the row settles when
 * the provider reports the task stopped, which unmounts this. A stop that is
 * not confirmed in time, or fails, is reported and Stop is offered again.
 */
function AgentStopControl({
  agent,
  identity,
  action,
  variant,
}: {
  agent: RuntimeSubagent;
  identity: SubagentStopIdentity;
  action: SubagentStopAction;
  variant: AgentStopVariant;
}) {
  const { label } = useAgentRowIdentity(agent);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reportUnconfirmed = useEffectEvent(() => {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Stop not confirmed",
        description: "The agent may still be running. You can try again.",
        data: { threadRef: action.threadRef },
      }),
    );
  });
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      requestVersion.current++;
      pendingRef.current = false;
      setPending(false);
      reportUnconfirmed();
    }, STOP_UNCONFIRMED_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const unavailableReason = action.unavailableReason;
  const stop = async () => {
    if (pendingRef.current || unavailableReason !== null) return;
    pendingRef.current = true;
    const version = ++requestVersion.current;
    setPending(true);
    try {
      await action.stop(identity);
    } catch (cause) {
      if (!mounted.current || version !== requestVersion.current) return;
      pendingRef.current = false;
      setPending(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not stop agent",
          description: describeSubagentStopFailure(cause),
          data: { threadRef: action.threadRef },
        }),
      );
    }
  };

  const disabled = pending || unavailableReason !== null;
  const accessibleName = `${pending ? "Stopping" : "Stop"} ${label}`;
  if (variant === "labeled") {
    return (
      <button
        type="button"
        onClick={() => void stop()}
        disabled={disabled}
        aria-label={accessibleName}
        title={unavailableReason ?? undefined}
        className="shrink-0 rounded px-2 py-1 text-xs hover:bg-muted disabled:cursor-default disabled:text-muted-foreground/50"
      >
        {pending ? "Stopping…" : "Stop"}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void stop()}
      disabled={disabled}
      aria-label={accessibleName}
      title={unavailableReason ?? (pending ? "Stopping…" : "Stop agent")}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors enabled:hover:bg-destructive/10 enabled:hover:text-destructive-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default",
        unavailableReason !== null && "opacity-50",
        "pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:size-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2",
      )}
    >
      {/* The composer's Stop generation square, without an icon import. */}
      <svg
        width="10"
        height="10"
        viewBox="0 0 12 12"
        fill="currentColor"
        aria-hidden="true"
        className={pending ? "animate-pulse" : undefined}
      >
        <rect x="2" y="2" width="8" height="8" rx="1.5" />
      </svg>
    </button>
  );
}
