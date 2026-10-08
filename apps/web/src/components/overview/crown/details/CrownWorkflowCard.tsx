import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import {
  agentPhaseStatusText,
  agentWorkflowStatusText,
  formatSubagentTokenCount,
  summarizeAgentWorkflow,
  workflowCardMembers,
  type AgentPanelWorkflowGroup,
  type AgentWorkflowPhase,
} from "../../../../threadWorkspaceViewModel";
import {
  AgentElapsed,
  AgentRow,
  AgentRowList,
  AgentStatusDot,
  PhaseMemberDots,
  type AgentRowDensity,
} from "../../../agents/agentRoster";

/** A running phase with nothing settled yet still shows a sliver of fill. */
const RUNNING_PHASE_MIN_FILL = 0.12;

/**
 * Member dots under one phase bar before they fold into "+N". Columns narrow
 * as phases multiply, so the cap shrinks with them; past five phases each
 * column shows its member count instead.
 */
function phaseDotMax(phaseCount: number): number {
  if (phaseCount <= 3) return 6;
  if (phaseCount <= 5) return 3;
  return 0;
}

/**
 * What a phase bar claims, read from its members rather than the phase state
 * alone: a phase "done" because its run ended never ran if it had no members
 * (skipped), and a done phase is only green when nothing in it failed or
 * stopped short.
 */
type PhaseTone = "succeeded" | "failed" | "stopped" | "running" | "pending" | "skipped";

function phaseTone(phase: AgentWorkflowPhase): PhaseTone {
  if (phase.members.length === 0) return phase.state === "done" ? "skipped" : "pending";
  if (phase.state !== "done") return phase.state;
  if (phase.members.some((member) => member.status === "failed")) return "failed";
  return phase.members.every((member) => member.status === "completed" || member.status === "idle")
    ? "succeeded"
    : "stopped";
}

/** How much of a phase bar is filled: settled phases are full, running shows settled members. */
function phaseFill(phase: AgentWorkflowPhase, tone: PhaseTone): number {
  if (tone === "pending" || tone === "skipped") return 0;
  if (tone !== "running") return 1;
  return Math.max(phase.settledCount / phase.members.length, RUNNING_PHASE_MIN_FILL);
}

const PHASE_FILL_CLASS: Record<PhaseTone, string> = {
  succeeded: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/50",
  running: "crown-agent-pulse bg-[color:var(--crown-agent,#38bdf8)]",
  pending: "bg-transparent",
  skipped: "bg-transparent",
};

function phaseStatusText(phase: AgentWorkflowPhase, tone: PhaseTone): string {
  if (tone === "skipped") return "not run";
  const failed = phase.members.filter((member) => member.status === "failed").length;
  const status = agentPhaseStatusText(phase);
  return failed > 0 ? `${status} · ${failed} failed` : status;
}

/**
 * One phase in the strip: a 4px bar with the phase's member dots (or count)
 * under it. Width and colour ride the crown's plan-bar duration, so reduced
 * motion settles them at once.
 */
function WorkflowPhase({ phase, dotMax }: { phase: AgentWorkflowPhase; dotMax: number }) {
  const tone = phaseTone(phase);
  const status = phaseStatusText(phase, tone);
  return (
    <li
      className="flex min-w-0 flex-col gap-1"
      data-slot="crown-workflow-phase"
      data-state={phase.state}
      data-tone={tone}
      title={`${phase.title} · ${status}`}
    >
      <span className="sr-only">{`${phase.title}, ${status}`}</span>
      <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-foreground/10">
        <span
          className={cn(
            "block h-full rounded-[inherit] transition-[width,background-color] duration-(--crown-dur-plan-bar) ease-(--crown-ease-out)",
            PHASE_FILL_CLASS[tone],
          )}
          data-slot="crown-workflow-phase-fill"
          style={{ width: `${Math.round(phaseFill(phase, tone) * 100)}%` }}
        />
      </span>
      {dotMax > 0 ? (
        <PhaseMemberDots
          members={phase.members}
          max={dotMax}
          className="h-2.5 min-w-0 overflow-hidden"
        />
      ) : (
        <span
          aria-hidden
          className="h-2.5 min-w-0 truncate font-mono text-[9.5px] leading-2.5 text-muted-foreground/70 tabular-nums"
        >
          {phase.members.length > 0 ? phase.members.length : ""}
        </span>
      )}
    </li>
  );
}

/**
 * A workflow run in the crown's Subagents detail, as the Agents tab shows it:
 * a header that opens the run in the Agents tab, the phase strip, the run's
 * status line and its most urgent members as compact rows. Rows read their
 * labels (and opener) from the surrounding AgentRosterProvider.
 */
export function CrownWorkflowCard({
  group,
  limit,
  rowDensity,
  showTokens,
  onOpenWorkflow,
}: {
  group: AgentPanelWorkflowGroup;
  /** Members listed before "+N more". */
  limit: number;
  /** Member row density: the flyout's narrow column drops the activity line. */
  rowDensity: AgentRowDensity;
  /** The run's token total beside its status line (the wider card only). */
  showTokens: boolean;
  onOpenWorkflow?: ((workflowId: string) => void) | undefined;
}) {
  const summary = summarizeAgentWorkflow(group);
  const statusText = agentWorkflowStatusText(summary);
  const { visible, overflow } = workflowCardMembers(group, limit);
  const open = onOpenWorkflow ? () => onOpenWorkflow(summary.id) : null;

  const headerContent: ReactNode = (
    <>
      <AgentStatusDot
        status={summary.displayStatus}
        {...(summary.displayStatus === "running" ? { className: "crown-agent-pulse" } : {})}
      />
      {/* The name keeps priority over the meta; tokens sit on the status line. */}
      <span
        className="min-w-[40%] flex-1 truncate text-[12.5px] font-semibold tracking-[-0.01em]"
        title={summary.name}
      >
        {summary.name}
      </span>
      <span className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap font-mono text-[10.5px] text-muted-foreground/80 tabular-nums">
        <span>
          {summary.settledCount}/{summary.memberCount}
        </span>
        {/* Hidden when the run has no time to show yet. */}
        <span className="before:content-['·_'] empty:hidden">
          <AgentElapsed agent={group.workflow} />
        </span>
      </span>
    </>
  );
  const headerClass = "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left";

  return (
    <div
      role="group"
      aria-label={summary.name}
      className="rounded-lg border border-foreground/8 bg-foreground/[0.025] p-1"
      data-slot="crown-workflow-card"
      data-workflow-id={summary.id}
      data-live={summary.live || undefined}
    >
      {open ? (
        <button
          type="button"
          className={cn(
            headerClass,
            "outline-none transition-colors hover:bg-accent/35 focus-visible:ring-2 focus-visible:ring-ring/50",
          )}
          data-slot="crown-workflow-header"
          aria-label={`Open ${summary.name} in Agents, ${statusText}`}
          onClick={open}
        >
          {headerContent}
        </button>
      ) : (
        <div className={headerClass} data-slot="crown-workflow-header">
          {headerContent}
        </div>
      )}
      {group.phases.length > 0 ? (
        <ol
          aria-label="Phases"
          className="m-0 mt-1 grid list-none gap-1.5 px-2 pb-0.5"
          style={{ gridTemplateColumns: `repeat(${group.phases.length}, minmax(0, 1fr))` }}
        >
          {group.phases.map((phase) => (
            <WorkflowPhase
              key={phase.index}
              phase={phase}
              dotMax={phaseDotMax(group.phases.length)}
            />
          ))}
        </ol>
      ) : null}
      <div className="mx-2 mt-1 flex min-w-0 items-baseline gap-2 text-[11px]">
        <p
          className={cn(
            "min-w-0 flex-1 truncate",
            !summary.live && summary.failedCount > 0
              ? "text-destructive-foreground"
              : "text-muted-foreground",
          )}
          data-slot="crown-workflow-status"
        >
          {statusText}
        </p>
        {showTokens ? (
          <span
            className="shrink-0 font-mono text-[10.5px] text-muted-foreground/80 tabular-nums"
            data-slot="crown-workflow-tokens"
          >
            {formatSubagentTokenCount(summary.totalTokens)} tok
          </span>
        ) : null}
      </div>
      <div className="mt-0.5">
        <AgentRowList>
          {visible.map((member) => (
            <AgentRow key={member.id} agent={member} density={rowDensity} />
          ))}
          {/* A run whose members have not spawned yet stands for its own work. */}
          {summary.memberCount === 0 ? (
            <AgentRow agent={group.workflow} density={rowDensity} />
          ) : null}
        </AgentRowList>
        {overflow > 0 ? (
          open ? (
            <button
              type="button"
              className="mx-1 mt-0.5 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-accent/35 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              data-slot="crown-workflow-more"
              aria-label={`Show all ${summary.memberCount} agents of ${summary.name} in Agents`}
              onClick={open}
            >
              +{overflow} more
            </button>
          ) : (
            <p
              className="mx-2 mt-0.5 text-[11px] text-muted-foreground"
              data-slot="crown-workflow-more"
            >
              +{overflow} more
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}
