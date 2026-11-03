/**
 * Shared agent roster UI: the status dot, ticking elapsed time, functional
 * labels and the fixed-geometry agent row, used by the Agents panel and the
 * crown's Subagents detail.
 *
 * Rows read their label and role from the nearest AgentRosterProvider, which
 * derives identities for the whole panel model once, so same-labelled agents
 * stay numbered apart wherever a row renders.
 */
import {
  createContext,
  use,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";

import { visibleSecondTicker } from "~/lib/perf/ticker";
import { cn } from "~/lib/utils";
import { subagentAvatarColor } from "../sidebar/SubagentAvatar";
import {
  agentActivityText,
  buildAgentRosterIdentity,
  elapsedBetween,
  resolveAgentRowIdentity,
  settledDuration,
  splitSubagentLabelScope,
  subagentMonogramInitials,
  SUBAGENT_STATUS_TEXT,
  type AgentPanelModel,
  type AgentRosterIdentity,
  type RuntimeSubagent,
} from "../../threadWorkspaceViewModel";
import { monogramInkColor } from "./agentRoster.logic";

/**
 * Status dot colors. Provider phases remain distinct, including resumable idle
 * agents; their words are the shared {@link SUBAGENT_STATUS_TEXT}, whose `word`
 * a row spells out next to its time: running and completed read from the dot
 * and the ticking/frozen time alone, every other state is named so it never
 * depends on color (or on a stale activity line).
 */
const AGENT_STATUS_DOT_CLASS: Record<RuntimeSubagent["status"], string> = {
  pending: "bg-info",
  running: "bg-info",
  waiting: "bg-info",
  // Idle reads as settled (muted, not sky): a resting Codex child looks done
  // unless resumed.
  idle: "bg-muted-foreground/50",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/60",
  interrupted: "bg-muted-foreground/60",
};

/** Status words in their own color; the rest take the row's muted aside color. */
const AGENT_STATUS_WORD_CLASS: Partial<Record<RuntimeSubagent["status"], string>> = {
  waiting: "text-info-foreground",
  failed: "text-destructive-foreground",
};

/**
 * Renders around a finished row, e.g. to set a control beside it: a row that
 * opens its agent is a button, so nothing interactive can go inside it. The
 * row fills its wrapper, which takes the row's height from
 * {@link AGENT_ROW_HEIGHT_CLASS}, so a list's divider stays inside that height.
 */
export type AgentRowDecorator = (
  agent: RuntimeSubagent,
  row: ReactElement,
  density: AgentRowDensity,
) => ReactNode;

interface AgentRosterContextValue extends AgentRosterIdentity {
  readonly onOpenAgent: ((agentId: string) => void) | null;
  readonly decorateRow: AgentRowDecorator | null;
}

const AgentRosterContext = createContext<AgentRosterContextValue>({
  identities: new Map(),
  labels: new Map(),
  onOpenAgent: null,
  decorateRow: null,
});

/**
 * Supplies roster identities for every row below it. With an opener, rows are
 * buttons that open the agent; without one they are static. A decorator
 * renders around every row.
 */
export function AgentRosterProvider({
  model,
  onOpenAgent = null,
  decorateRow = null,
  children,
}: {
  model: AgentPanelModel;
  onOpenAgent?: ((agentId: string) => void) | null | undefined;
  decorateRow?: AgentRowDecorator | null | undefined;
  children: ReactNode;
}) {
  const identity = useMemo(() => buildAgentRosterIdentity(model), [model]);
  const value = useMemo<AgentRosterContextValue>(
    () => ({ ...identity, onOpenAgent, decorateRow }),
    [identity, onOpenAgent, decorateRow],
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

/** Resolves row labels for any number of agents under the nearest provider. */
export function useAgentRowLabel(): (agent: RuntimeSubagent) => string {
  const roster = use(AgentRosterContext);
  return (agent) => resolveAgentRowIdentity(agent, roster).label;
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
      className={cn("size-1.5 shrink-0 rounded-full", AGENT_STATUS_DOT_CLASS[status], className)}
    />
  );
}

/**
 * An agent's monogram: initials from its row label on a color keyed by its
 * name (the title, so a label renumbered by a later namesake keeps its
 * color), with its status as a corner badge.
 */
export function AgentMonogram({
  agent,
  label,
  className,
  style,
}: {
  agent: RuntimeSubagent;
  label: string;
  className?: string;
  style?: CSSProperties;
}) {
  const color = subagentAvatarColor(agent.title || agent.id);
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-[18px] shrink-0 items-center justify-center rounded-full text-[8px] font-semibold tracking-[0.02em] select-none",
        className,
      )}
      style={{ ...style, backgroundColor: color, color: monogramInkColor(color) }}
    >
      {subagentMonogramInitials(label)}
      <span
        data-slot="agent-status-badge"
        className={cn(
          "absolute -right-0.5 -bottom-0.5 size-[7px] rounded-full ring-[1.5px] ring-background",
          AGENT_STATUS_DOT_CLASS[agent.status],
        )}
      />
    </span>
  );
}

/**
 * Overlapping monograms for a batch of agents; past `max`, a `+N` count. With
 * `total`, the count also covers agents of the batch not passed in.
 */
export function AgentMonogramStack({
  agents,
  max = 4,
  total = agents.length,
  className,
}: {
  agents: ReadonlyArray<RuntimeSubagent>;
  max?: number;
  total?: number;
  className?: string;
}) {
  const shown = agents.slice(0, Math.max(0, max));
  const overflow = Math.max(total, agents.length) - shown.length;
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center", className)}>
      {shown.map((agent, index) => (
        // Earlier monograms sit on top, so each status badge stays visible
        // over the next monogram instead of under it.
        <StackedMonogram
          key={agent.id}
          agent={agent}
          first={index === 0}
          layer={shown.length - index}
        />
      ))}
      {overflow > 0 ? (
        <span className="ml-1 font-mono text-[10px] text-muted-foreground/75">+{overflow}</span>
      ) : null}
    </span>
  );
}

function StackedMonogram({
  agent,
  first,
  layer,
}: {
  agent: RuntimeSubagent;
  first: boolean;
  layer: number;
}) {
  const { label } = useAgentRowIdentity(agent);
  return (
    <AgentMonogram
      agent={agent}
      label={label}
      className={cn("ring-[1.5px] ring-background", !first && "-ml-0.5")}
      style={{ zIndex: layer }}
    />
  );
}

/**
 * Elapsed time for the current activation. Live agents tick on the shared
 * second clock via DOM writes (zero React commits per tick); settled agents
 * freeze at the run's actual duration.
 */
export function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    return visibleSecondTicker.subscribe((nowMs) => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null, nowMs);
      }
    });
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
 * Row geometry per density, with its height in {@link AGENT_ROW_HEIGHT_CLASS};
 * updates never change a row's height.
 * - panel: monogram, then two lines (label + time, then activity + role/run), 40px.
 * - compact: one line (monogram, label, activity, status word + time), 30px.
 * - mini: compact without the activity, for columns too narrow to show it.
 */
const AGENT_ROW_GRID_CLASS = {
  panel:
    "grid w-full grid-cols-[1.125rem_minmax(0,1fr)_auto] grid-rows-[1.125rem_1rem] content-center items-center gap-x-2.5 rounded-md px-2 text-left",
  compact:
    "grid w-full grid-cols-[1.125rem_minmax(0,max-content)_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2 text-left",
  mini: "grid w-full grid-cols-[1.125rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2 text-left",
} as const;

export type AgentRowDensity = keyof typeof AGENT_ROW_GRID_CLASS;

/** A row's fixed height; a decorated row's wrapper takes it instead. */
export const AGENT_ROW_HEIGHT_CLASS: Record<AgentRowDensity, string> = {
  panel: "h-10",
  compact: "h-[30px]",
  mini: "h-[30px]",
};

/** Fixed-height row: what the agent is, then what it is doing now. */
export function AgentRow({
  agent,
  density = "panel",
}: {
  agent: RuntimeSubagent;
  density?: AgentRowDensity;
}) {
  const { onOpenAgent, decorateRow } = use(AgentRosterContext);
  const { label, role } = useAgentRowIdentity(agent);
  const statusText = SUBAGENT_STATUS_TEXT[agent.status];
  const activity = agentActivityText(agent);
  // A named status already says what a quiet row is doing; do not repeat it.
  const activityLine = activity ?? (statusText.word ? "" : statusText.label);
  const activityTone =
    agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground";
  const statusWord = statusText.word ? (
    <span className={cn("font-sans", AGENT_STATUS_WORD_CLASS[agent.status])}>
      {statusText.word}
    </span>
  ) : null;
  // Rows without a visible status word still name their status (buttons
  // carry it in their accessible name instead).
  const srStatus =
    statusText.word || onOpenAgent ? null : <span className="sr-only">{statusText.label}</span>;

  let content: ReactNode;
  if (density === "compact" || density === "mini") {
    content = (
      <>
        <span className="flex">
          <AgentMonogram agent={agent} label={label} />
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
        <span
          data-agent-row-aside
          className="inline-flex items-center justify-end gap-1.5 text-right font-mono text-[10.5px] text-muted-foreground/70"
        >
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
        <span className="col-start-1 row-span-2 row-start-1 flex">
          <AgentMonogram agent={agent} label={label} />
        </span>
        <AgentLabel label={label} className="col-start-2 row-start-1" />
        <span
          data-agent-row-aside
          className="col-start-3 row-start-1 inline-flex items-center justify-end gap-1.5 text-right font-mono text-[10.5px] text-muted-foreground/70"
        >
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
          <span
            data-agent-row-aside
            className="col-start-3 row-start-2 max-w-32 truncate text-right text-[10.5px] text-muted-foreground/65"
          >
            {aside}
          </span>
        ) : null}
        {srStatus}
      </>
    );
  }

  const className = cn(
    AGENT_ROW_GRID_CLASS[density],
    decorateRow ? "h-full" : AGENT_ROW_HEIGHT_CLASS[density],
    "outline-none transition-colors",
    onOpenAgent && "hover:bg-accent/35 focus-visible:ring-2 focus-visible:ring-ring/50",
  );
  const densityAttribute = density === "panel" ? {} : { "data-density": density };
  const row = onOpenAgent ? (
    <button
      type="button"
      className={className}
      data-agent-row
      data-agent-id={agent.id}
      {...densityAttribute}
      onClick={() => onOpenAgent(agent.id)}
      aria-label={`Open ${label}${role ? `, ${role}` : ""} transcript. ${statusText.label}.`}
    >
      {content}
    </button>
  ) : (
    <div className={className} data-agent-row data-agent-id={agent.id} {...densityAttribute}>
      {content}
    </div>
  );
  return decorateRow ? decorateRow(agent, row, density) : row;
}
