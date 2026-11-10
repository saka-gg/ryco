/**
 * The chat's one-line marker per spawn batch (a workflow run or a turn's direct
 * spawns): the agents' monograms, what was started and how many still work, or
 * that it finished and what it cost. It keeps the batch's place in the story
 * without a card; live detail belongs to the dock above the composer. It
 * expands in place into the agents' rows; a row opens that agent in the Agents
 * panel, which stays the full roster.
 */
import { ChevronRightIcon } from "lucide-react";
import { memo, useId } from "react";

import { cn } from "~/lib/utils";
import {
  agentActivityText,
  agentWorkflowStatusText,
  formatSubagentTokenCount,
  type AgentPanelModel,
} from "../../threadWorkspaceViewModel";
import {
  AgentMonogramStack,
  AgentRosterProvider,
  AgentRow,
  AgentRowList,
  useAgentRowLabel,
} from "../agents/agentRoster";
import {
  summarizeAgentSpawn,
  type AgentSpawnRef,
  type AgentSpawnSummary,
} from "./agentSpawnRow.logic";

export const AgentSpawnRow = memo(function AgentSpawnRow(props: {
  spawn: AgentSpawnRef;
  model: AgentPanelModel;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onOpenAgents: () => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const { spawn, model, expanded, onExpandedChange, onOpenAgents, onOpenAgent } = props;
  const summary = summarizeAgentSpawn(spawn, model);
  return (
    <AgentRosterProvider model={model} onOpenAgent={onOpenAgent}>
      <AgentSpawnRowContent
        summary={summary}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        onOpenAgents={onOpenAgents}
      />
    </AgentRosterProvider>
  );
});

function AgentSpawnRowContent({
  summary,
  expanded,
  onExpandedChange,
  onOpenAgents,
}: {
  summary: AgentSpawnSummary;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onOpenAgents: () => void;
}) {
  const labelOf = useAgentRowLabel();
  const listId = useId();
  const { members, visibleMembers, agentCount, live, failedCount, latestWorking } = summary;
  const noun = `subagent${agentCount === 1 ? "" : "s"}`;
  const lead = live ? `Kicked off ${agentCount} ${noun}` : `${agentCount} ${noun} finished`;
  // What the batch is: the run's name, else the agents that made it up.
  const subject = summary.workflowName ?? (live ? null : visibleMembers.map(labelOf).join(", "));
  // Live: the phase and how many still work. Settled: only a failure is news.
  const status = live
    ? agentWorkflowStatusText({
        live,
        livePhase: summary.livePhase,
        workingCount: summary.workingCount,
        failedCount,
      })
    : failedCount > 0
      ? `${failedCount} failed`
      : null;
  // Who acted last stays a hover away; the dock above the composer shows it live.
  const activity = latestWorking
    ? [labelOf(latestWorking), agentActivityText(latestWorking)].filter(Boolean).join(" · ")
    : (summary.latestWorkflowActivity ?? undefined);
  const hidden = Math.max(agentCount, members.length) - visibleMembers.length;

  return (
    <div data-agent-spawn-row>
      <button
        type="button"
        onClick={() => onExpandedChange(!expanded)}
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        title={activity || undefined}
        className="group/agent-spawn flex min-h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-[12px] leading-5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <AgentMonogramStack agents={visibleMembers} max={3} total={agentCount} />
        <span className="min-w-0 flex-1 truncate">
          {lead}
          {subject ? ` · ${subject}` : null}
          {status ? (
            <>
              {" · "}
              <span className={live ? "text-info-foreground" : "text-destructive-foreground"}>
                {status}
              </span>
            </>
          ) : null}
          {!live && summary.totalTokens > 0 ? (
            <span className="tabular-nums">
              {" · "}
              {formatSubagentTokenCount(summary.totalTokens)} tok
            </span>
          ) : null}
        </span>
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 opacity-60 transition-[rotate]",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded ? (
        <div id={listId} className="mt-1 ml-[18px] border-l border-border/50 pl-2">
          <AgentRowList>
            {visibleMembers.map((agent) => (
              <AgentRow key={agent.id} agent={agent} density="compact" />
            ))}
          </AgentRowList>
          <button
            type="button"
            onClick={onOpenAgents}
            className="mt-0.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {hidden > 0 ? `${hidden} more in the Agents panel` : "Open the Agents panel"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
