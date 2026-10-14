/**
 * The chat's one row per spawn batch (a workflow run or a turn's direct
 * spawns): the agents' monograms, what the most recently active one is doing,
 * and how many still work. It expands in place into the agents' rows; a row
 * opens that agent in the Agents panel, which stays the full roster.
 */
import { ChevronRightIcon } from "lucide-react";
import { memo, useId } from "react";

import { cn } from "~/lib/utils";
import {
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
import { agentActivityText } from "../agents/agentRoster.logic";
import { glassSurfaceClassName } from "../mobile/GlassSurface";
import {
  summarizeAgentSpawn,
  type AgentSpawnRef,
  type AgentSpawnSummary,
} from "./agentSpawnRow.logic";

/** Rows an expanded batch lists before deferring to the Agents panel. */
const EXPANDED_AGENT_LIMIT = 8;

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
  const { members, agentCount, live, workingCount, failedCount, latestWorking } = summary;
  const noun = `subagent${agentCount === 1 ? "" : "s"}`;
  const lead = live ? `Kicked off ${agentCount} ${noun}` : `Ran ${agentCount} ${noun}`;
  const status = agentWorkflowStatusText({ live, livePhase: null, workingCount, failedCount });
  // Live: who acted last and what they are doing. Settled: which agents ran.
  const latestAction = latestWorking ? agentActivityText(latestWorking) : null;
  const detail = latestWorking
    ? { name: labelOf(latestWorking), text: latestAction }
    : { name: null, text: members.map(labelOf).join(", ") };
  const shown = members.slice(0, EXPANDED_AGENT_LIMIT);
  const hidden = members.length - shown.length;

  return (
    <div data-agent-spawn-row>
      <button
        type="button"
        onClick={() => onExpandedChange(!expanded)}
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        className={cn(
          glassSurfaceClassName("chip"),
          "group/agent-spawn grid min-h-[40px] w-full grid-cols-[auto_minmax(0,1fr)_auto_1rem] items-center gap-x-2.5 rounded-lg border border-border/50 px-2.5 py-1 text-left transition-colors hover:border-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        )}
      >
        <AgentMonogramStack agents={members} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[12px] leading-[18px]">
            <span className="font-medium text-foreground/90">{lead}</span>
            {summary.workflowName ? (
              <span className="text-muted-foreground"> · {summary.workflowName}</span>
            ) : null}
          </span>
          {detail.text ? (
            <span className="truncate text-[11px] leading-4 text-muted-foreground">
              {detail.name ? <span className="text-foreground/80">{detail.name} · </span> : null}
              {detail.text}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[11px] leading-5 text-muted-foreground">
          <span
            className={cn(
              live ? "text-info-foreground" : failedCount > 0 && "text-destructive-foreground",
            )}
          >
            {status}
          </span>
          {summary.totalTokens > 0 ? (
            <span className="tabular-nums">
              {formatSubagentTokenCount(summary.totalTokens)} tok
            </span>
          ) : null}
        </span>
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 text-muted-foreground/60 transition-[color,rotate] group-hover/agent-spawn:text-foreground",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded ? (
        <div id={listId} className="mt-1 ml-[18px] border-l border-border/50 pl-2">
          <AgentRowList>
            {shown.map((agent) => (
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
