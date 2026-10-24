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
import { useEffect, useSyncExternalStore, type ReactElement } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import type { RuntimeSubagent } from "../../threadWorkspaceViewModel";
import {
  AGENT_ROW_HEIGHT_CLASS,
  useAgentRowIdentity,
  type AgentRowDecorator,
  type AgentRowDensity,
} from "./agentRoster";
import { describeSubagentStopFailure, subagentStopKey } from "./agentStop.logic";
import { agentStopRequests } from "./agentStopRequests";

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
  return identity ? (
    <AgentStopControl agent={agent} identity={identity} action={action} variant={variant} />
  ) : null;
}

/**
 * Wraps a roster row so its Stop sits beside it rather than inside it (an
 * opening row is a button). The wrapper is there for every row, so a row never
 * remounts when it becomes stoppable, and it takes the row's height, so a list
 * divider on it adds none. On hover or focus, Stop takes the place of the row's
 * time and status. On touch, or any other device that can't hover, it stays in
 * view: it takes no pointer events while hidden, so a hover it never gets would
 * leave it out of reach. The time hides under the same conditions that show
 * Stop, so the row always shows one of the two.
 */
function AgentStopRow({
  agent,
  row,
  density,
  action,
}: {
  agent: RuntimeSubagent;
  row: ReactElement;
  density: AgentRowDensity;
  action: SubagentStopAction;
}) {
  const stoppable = subagentStopIdentity(agent, action.runtimeSessionId) !== null;
  return (
    <div
      className={cn(
        "group/agent-row relative",
        AGENT_ROW_HEIGHT_CLASS[density],
        stoppable && [
          // The opening row keeps its hover tint while the pointer is on Stop.
          "hover:[&>button[data-agent-row]]:bg-accent/35 [&_[data-agent-row-aside]]:transition-opacity",
          // `hover:` and `group-hover:` only apply on devices that can hover.
          "hover:[&_[data-agent-row-aside]]:opacity-0 focus-within:[&_[data-agent-row-aside]]:opacity-0 pointer-coarse:[&_[data-agent-row-aside]]:opacity-0 [@media(hover:none)]:[&_[data-agent-row-aside]]:opacity-0",
        ],
      )}
    >
      {row}
      {stoppable ? (
        <span className="pointer-events-none absolute top-1/2 right-1.5 flex -translate-y-1/2 opacity-0 transition-opacity group-hover/agent-row:pointer-events-auto group-hover/agent-row:opacity-100 group-focus-within/agent-row:pointer-events-auto group-focus-within/agent-row:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
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
  return (agent, row, density) => (
    <AgentStopRow agent={agent} row={row} density={density} action={action} />
  );
}

/**
 * The node accepting a stop is not the agent stopping: the row settles when
 * the provider reports the task stopped, which unmounts this. A stop that is
 * not confirmed in time, or fails, is reported and Stop is offered again.
 * Every control for the same agent shares one request (see agentStopRequests).
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
  const key = subagentStopKey(action.threadRef, identity);
  const pending = useSyncExternalStore(agentStopRequests.subscribe, () =>
    agentStopRequests.isPending(key),
  );
  useEffect(() => agentStopRequests.watch(key), [key]);

  const unavailableReason = action.unavailableReason;
  const stop = () => {
    if (unavailableReason !== null) return;
    const { threadRef } = action;
    agentStopRequests.start(key, () => action.stop(identity), {
      onUnconfirmed: () =>
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Stop not confirmed",
            description: "The agent may still be running. You can try again.",
            data: { threadRef },
          }),
        ),
      onFailed: (cause) =>
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not stop agent",
            description: describeSubagentStopFailure(cause),
            data: { threadRef },
          }),
        ),
    });
  };

  const disabled = pending || unavailableReason !== null;
  const accessibleName = `${pending ? "Stopping" : "Stop"} ${label}`;
  if (variant === "labeled") {
    // Overhangs its line, so a header keeps its height as Stop comes and goes.
    return (
      <button
        type="button"
        onClick={stop}
        disabled={disabled}
        aria-label={accessibleName}
        title={unavailableReason ?? undefined}
        className="-my-1 shrink-0 rounded px-2 py-1 text-xs hover:bg-muted disabled:cursor-default disabled:text-muted-foreground/50"
      >
        {pending ? "Stopping…" : "Stop"}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={stop}
      disabled={disabled}
      aria-label={accessibleName}
      title={unavailableReason ?? (pending ? "Stopping…" : "Stop agent")}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors enabled:hover:bg-destructive/10 enabled:hover:text-destructive-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default",
        unavailableReason !== null && "opacity-50",
        // A wider touch target, but no taller than the shortest (30px) row, so
        // it never takes a tap meant for the row above or below.
        "pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:h-7 pointer-coarse:after:w-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2",
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
