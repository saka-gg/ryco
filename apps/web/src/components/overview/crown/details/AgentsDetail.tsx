import type { CSSProperties } from "react";

import {
  emptyAgentPanelModel,
  formatSubagentTokenCount,
} from "../../../../threadWorkspaceViewModel";
import { AgentRosterProvider, AgentRow, AgentRowList } from "../../../agents/agentRoster";
import { CROWN_WORKFLOW_MEMBER_LIMIT } from "../crownLayout";
import {
  CrownDetailEmpty,
  CrownDetailFootnote,
  CrownDetailHeading,
  CrownGroupHeader,
  type CrownDetailViewProps,
} from "./crownDetailPrimitives";
import { CrownWorkflowCard } from "./CrownWorkflowCard";

/**
 * Live agents in the crown read in its agent sky (the rail icon, the running
 * phase fill), so the shared rows' `info` dots take that hue here.
 */
const CROWN_AGENT_HUE_STYLE = { "--color-info": "var(--crown-agent, #38bdf8)" } as CSSProperties;

/**
 * The Subagents section: workflow runs as cards, then direct spawns as
 * compact rows, the way the Agents tab groups them. A member row opens that
 * agent in the Agents tab; a card header (or "+N more") opens the tab focused
 * on its run.
 */
export function AgentsDetail({ layout, variant }: CrownDetailViewProps) {
  const model = layout.agentPanelModel ?? emptyAgentPanelModel();
  const limit = CROWN_WORKFLOW_MEMBER_LIMIT[variant];
  // The flyout's column is too narrow for a row's activity line.
  const rowDensity = variant === "flyout" ? "mini" : "compact";
  const { workflows, directAgents } = model;
  return (
    <>
      <CrownDetailHeading
        section="agents"
        variant={variant}
        meta={model.hasAgents ? `${model.liveCount} live` : undefined}
      />
      {model.hasAgents ? (
        <AgentRosterProvider model={model} onOpenAgent={layout.onOpenAgent ?? null}>
          <div className="contents" style={CROWN_AGENT_HUE_STYLE}>
            {workflows.length > 0 ? (
              <div className="flex flex-col gap-1.5" data-slot="crown-workflows">
                {workflows.map((group) => (
                  <CrownWorkflowCard
                    key={group.workflow.id}
                    group={group}
                    limit={limit}
                    rowDensity={rowDensity}
                    showTokens={variant === "card"}
                    onOpenWorkflow={layout.onOpenAgentsWorkflow}
                  />
                ))}
              </div>
            ) : null}
            {directAgents.length > 0 ? (
              <div data-slot="crown-direct-agents">
                {/* Without workflows every agent is direct; the group needs no name. */}
                {workflows.length > 0 ? (
                  <CrownGroupHeader label="Direct" count={directAgents.length} />
                ) : null}
                <AgentRowList>
                  {directAgents.map((agent) => (
                    <AgentRow key={agent.id} agent={agent} density={rowDensity} />
                  ))}
                </AgentRowList>
              </div>
            ) : null}
            {variant === "card" ? (
              <CrownDetailFootnote>
                {`${formatSubagentTokenCount(model.totalTokens)} tok · ${model.liveCount} active · ${model.settledCount} settled`}
              </CrownDetailFootnote>
            ) : null}
          </div>
        </AgentRosterProvider>
      ) : (
        <CrownDetailEmpty>No subagents in this thread</CrownDetailEmpty>
      )}
    </>
  );
}
