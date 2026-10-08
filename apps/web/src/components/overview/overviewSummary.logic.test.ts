import { assert, describe, it } from "vite-plus/test";

import { makeRuntimeAgent } from "../agents/agentRosterTestFixtures";
import {
  auditWorkflowAgents,
  crownAgentPanelFixture,
  makeAgentPanelModel,
  makeLayout,
  makeSubagent,
} from "./crown/crownTestFixtures";
import { getOverviewSummary } from "./overviewSummary.logic";

describe("getOverviewSummary agents", () => {
  it("counts transcript subagents, running ones live, without a runtime model", () => {
    const summary = getOverviewSummary(
      makeLayout({
        subagents: [
          makeSubagent("a", "running"),
          makeSubagent("b", "finished"),
          makeSubagent("c", "idle"),
        ],
      }),
    );
    assert.equal(summary.agentsTotal, 3);
    assert.equal(summary.agentsRunning, 1);
    assert.equal(getOverviewSummary(makeLayout()).agentsTotal, 0);
  });

  it("counts the runtime model's agents and live count when it is set", () => {
    const summary = getOverviewSummary(
      makeLayout({
        agentPanelModel: crownAgentPanelFixture(),
        subagents: [makeSubagent("a", "running")],
      }),
    );
    // Four workflow members and two direct agents; the coordinator stands in for its members.
    assert.equal(summary.agentsTotal, 6);
    assert.equal(summary.agentsRunning, 2);
  });

  it("treats waiting runtime agents as live and a memberless coordinator as an agent", () => {
    const waiting = getOverviewSummary(
      makeLayout({
        agentPanelModel: makeAgentPanelModel([makeRuntimeAgent("a", { status: "waiting" })]),
      }),
    );
    assert.equal(waiting.agentsRunning, 1);
    const bare = getOverviewSummary(
      makeLayout({ agentPanelModel: makeAgentPanelModel(auditWorkflowAgents().slice(0, 1)) }),
    );
    assert.equal(bare.agentsTotal, 1);
    assert.equal(bare.agentsRunning, 1);
  });
});
