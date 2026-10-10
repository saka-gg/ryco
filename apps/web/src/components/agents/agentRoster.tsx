/**
 * Shared agent roster UI: the status dot, ticking elapsed time, functional
 * labels and the fixed-geometry agent row, used by the Agents panel and the
 * crown's Subagents detail.
 *
 * Rows read their label and role from the nearest AgentRosterProvider, which
 * derives identities for the whole panel model once, so same-labelled agents
 * stay numbered apart wherever a row renders.
 */
import { createContext, use, useEffect, useMemo, useRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  buildAgentRosterIdentity,
  resolveAgentRowIdentity,
  splitSubagentLabelScope,
  type AgentPanelModel,
  type AgentRosterIdentity,
  type RuntimeSubagent,
} from "../../threadWorkspaceViewModel";
import { agentActivityText, elapsedBetween, settledDuration } from "./agentRoster.logic";

/**
 * Provider phases remain distinct, including resumable idle agents. `word` is
 * the status a row spells out next to its time: running and completed read
 * from the dot and the ticking/frozen time alone, every other state is named
 * so it never depends on color (or on a stale activity line).
 */
export const AGENT_STATUS_VISUALS: Record<
  RuntimeSubagent["status"],
  { dotClass: string; label: string; word: { text: string; className: string } | null }
> = {
  pending: { dotClass: "bg-info", label: "Queued", word: { text: "Queued", className: "" } },
  running: { dotClass: "bg-info", label: "Running", word: null },
  waiting: {
    dotClass: "bg-info",
    label: "Waiting",
    word: { text: "Waiting", className: "text-info-foreground" },
  },
  // Idle reads as settled (muted, not sky): a resting Codex child looks done
  // unless resumed.
  idle: {
    dotClass: "bg-muted-foreground/50",
    label: "Idle · resumable",
    word: { text: "Idle", className: "" },
  },
  completed: { dotClass: "bg-success", label: "Completed", word: null },
  failed: {
    dotClass: "bg-destructive",
    label: "Failed",
    word: { text: "Failed", className: "text-destructive-foreground" },
  },
  cancelled: {
    dotClass: "bg-muted-foreground/60",
    label: "Stopped",
    word: { text: "Stopped", className: "" },
  },
  interrupted: {
    dotClass: "bg-muted-foreground/60",
    label: "Interrupted",
    word: { text: "Interrupted", className: "" },
  },
};

interface AgentRosterContextValue extends AgentRosterIdentity {
  readonly onOpenAgent: ((agentId: string) => void) | null;
}

const AgentRosterContext = createContext<AgentRosterContextValue>({
  identities: new Map(),
  labels: new Map(),
  onOpenAgent: null,
});

/**
 * Supplies roster identities for every row below it. With an opener, rows are
 * buttons that open the agent; without one they are static.
 */
export function AgentRosterProvider({
  model,
  onOpenAgent = null,
  children,
}: {
  model: AgentPanelModel;
  onOpenAgent?: ((agentId: string) => void) | null | undefined;
  children: ReactNode;
}) {
  const identity = useMemo(() => buildAgentRosterIdentity(model), [model]);
  const value = useMemo<AgentRosterContextValue>(
    () => ({ ...identity, onOpenAgent }),
    [identity, onOpenAgent],
  );
  return <AgentRosterContext value={value}>{children}</AgentRosterContext>;
}

/** The label a row leads with and the role it sets beside it. */
export function useAgentRowIdentity(agent: RuntimeSubagent): {
  readonly label: string;
  readonly role: string | null;
} {
  const roster = use(AgentRosterContext);
  return resolveAgentRowIdentity(agent, roster);
}

export function AgentStatusDot({
  status,
  className,
}: {
  status: RuntimeSubagent["status"];
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        AGENT_STATUS_VISUALS[status].dotClass,
        className,
      )}
    />
  );
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at the run's
 * actual duration.
 */
export function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!live) {
    const duration = settledDuration(agent);
    return duration ? <span className="tabular-nums">{duration}</span> : null;
  }
  if (!startedAt) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, null)}
    </span>
  );
}

/** Hairline separation between stacked agent rows. */
export function AgentRowList({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border/25">{children}</div>;
}

/**
 * A workflow label's `scope:` prefix (`verify:`, `review:`) is set back so the
 * agent's own name carries the row.
 */
export function AgentLabel({
  label,
  className,
  wrap = false,
}: {
  label: string;
  className?: string;
  /** Show the whole label (the detail header) instead of truncating it. */
  wrap?: boolean;
}) {
  const { scope, name } = splitSubagentLabelScope(label);
  return (
    <span
      className={cn(
        "min-w-0 text-[13px] font-medium",
        wrap ? "break-words" : "truncate",
        className,
      )}
      title={wrap ? undefined : label}
    >
      {scope ? <span className="font-normal text-muted-foreground/70">{scope}:</span> : null}
      {name}
    </span>
  );
}

/**
 * Member status dots in roster order, e.g. beside a collapsed phase. With
 * `max`, dots past it fold into a `+N` count.
 */
export function PhaseMemberDots({
  members,
  max,
  className,
}: {
  members: ReadonlyArray<RuntimeSubagent>;
  max?: number;
  className?: string;
}) {
  const shown = max === undefined ? members : members.slice(0, Math.max(0, max));
  const overflow = members.length - shown.length;
  return (
    <span className={cn("flex items-center gap-0.5", className)}>
      {shown.map((member) => (
        <AgentStatusDot key={member.id} status={member.status} />
      ))}
      {overflow > 0 ? (
        <span aria-hidden className="ml-0.5 font-mono text-[9.5px] text-muted-foreground/70">
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Row geometry per density; updates never change a row's height.
 * - panel: two lines (label + time, then activity + role/run), 40px.
 * - compact: one line (label, activity, status word + time), 30px.
 * - mini: compact without the activity, for columns too narrow to show it.
 */
const AGENT_ROW_GRID_CLASS = {
  panel:
    "grid h-10 w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.125rem_1rem] content-center items-center gap-x-2.5 rounded-md px-2 text-left",
  compact:
    "grid h-[30px] w-full grid-cols-[0.375rem_minmax(0,max-content)_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2 text-left",
  mini: "grid h-[30px] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2 text-left",
} as const;

export type AgentRowDensity = keyof typeof AGENT_ROW_GRID_CLASS;

/** Fixed-height row: what the agent is, then what it is doing now. */
export function AgentRow({
  agent,
  density = "panel",
}: {
  agent: RuntimeSubagent;
  density?: AgentRowDensity;
}) {
  const { onOpenAgent } = use(AgentRosterContext);
  const { label, role } = useAgentRowIdentity(agent);
  const visuals = AGENT_STATUS_VISUALS[agent.status];
  const activity = agentActivityText(agent);
  // A named status already says what a quiet row is doing; do not repeat it.
  const activityLine = activity ?? (visuals.word ? "" : visuals.label);
  const activityTone =
    agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground";
  const statusWord = visuals.word ? (
    <span className={cn("font-sans", visuals.word.className)}>{visuals.word.text}</span>
  ) : null;
  // Rows without a visible status word still name their status (buttons
  // carry it in their accessible name instead).
  const srStatus =
    visuals.word || onOpenAgent ? null : <span className="sr-only">{visuals.label}</span>;

  let content: ReactNode;
  if (density === "compact" || density === "mini") {
    content = (
      <>
        <span className="flex">
          <AgentStatusDot status={agent.status} />
        </span>
        <AgentLabel label={label} className="text-[12px]" />
        {density === "compact" ? (
          <span
            className={cn("block min-w-0 truncate text-[11px]", activityTone)}
            title={activityLine || undefined}
          >
            {activityLine}
          </span>
        ) : null}
        <span className="inline-flex items-center justify-end gap-1.5 text-right font-mono text-[10.5px] text-muted-foreground/70">
          {statusWord}
          <AgentElapsed agent={agent} />
        </span>
        {srStatus}
      </>
    );
  } else {
    const aside = [role, agent.activationCount > 1 ? `run ${agent.activationCount}` : null]
      .filter((value): value is string => value !== null)
      .join(" · ");
    content = (
      <>
        <span className="col-start-1 row-start-1 flex">
          <AgentStatusDot status={agent.status} />
        </span>
        <AgentLabel label={label} className="col-start-2 row-start-1" />
        <span className="col-start-3 row-start-1 inline-flex items-center justify-end gap-1.5 text-right font-mono text-[10.5px] text-muted-foreground/70">
          {statusWord}
          <AgentElapsed agent={agent} />
        </span>
        <span
          className={cn(
            "col-start-2 row-start-2 block min-w-0 truncate text-[11.5px]",
            activityTone,
          )}
          title={activityLine || undefined}
        >
          {activityLine}
        </span>
        {aside ? (
          <span className="col-start-3 row-start-2 max-w-32 truncate text-right text-[10.5px] text-muted-foreground/65">
            {aside}
          </span>
        ) : null}
        {srStatus}
      </>
    );
  }

  const className = cn(
    AGENT_ROW_GRID_CLASS[density],
    "outline-none transition-colors",
    onOpenAgent && "hover:bg-accent/35 focus-visible:ring-2 focus-visible:ring-ring/50",
  );
  const densityAttribute = density === "panel" ? {} : { "data-density": density };
  return onOpenAgent ? (
    <button
      type="button"
      className={className}
      data-agent-row
      data-agent-id={agent.id}
      {...densityAttribute}
      onClick={() => onOpenAgent(agent.id)}
      aria-label={`Open ${label}${role ? `, ${role}` : ""} transcript. ${visuals.label}.`}
    >
      {content}
    </button>
  ) : (
    <div className={className} data-agent-row data-agent-id={agent.id} {...densityAttribute}>
      {content}
    </div>
  );
}
