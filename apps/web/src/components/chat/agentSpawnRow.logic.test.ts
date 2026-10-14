import { describe, expect, it } from "vite-plus/test";

import { deriveAgentPanelModel } from "../../threadWorkspaceViewModel";
import { makeRuntimeAgent } from "../agents/agentRosterTestFixtures";
import { summarizeAgentSpawn } from "./agentSpawnRow.logic";

describe("summarizeAgentSpawn", () => {
  const model = deriveAgentPanelModel({
    agents: [
      makeRuntimeAgent("a", {
        status: "running",
        updatedAt: "2026-08-10T10:00:05.000Z",
        usage: { totalTokens: 1200 },
      }),
      makeRuntimeAgent("b", {
        status: "running",
        updatedAt: "2026-08-10T10:00:09.000Z",
        firstSeenAt: "2026-08-10T10:00:01.000Z",
      }),
      makeRuntimeAgent("c", {
        status: "failed",
        firstSeenAt: "2026-08-10T10:00:02.000Z",
        usage: { totalTokens: 300 },
      }),
      makeRuntimeAgent("other", { firstSeenAt: "2026-08-10T10:00:03.000Z" }),
    ],
  });

  it("reads only the batch's agents and follows the one that reported last", () => {
    const summary = summarizeAgentSpawn({ workflowId: null, agentTaskIds: ["a", "b", "c"] }, model);

    expect(summary.members.map((agent) => agent.id)).toEqual(["a", "b", "c"]);
    expect(summary).toMatchObject({
      agentCount: 3,
      workingCount: 2,
      failedCount: 1,
      live: true,
      totalTokens: 1500,
    });
    expect(summary.latestWorking?.id).toBe("b");
  });

  it("has no latest action once every agent settled", () => {
    const summary = summarizeAgentSpawn({ workflowId: null, agentTaskIds: ["c"] }, model);

    expect(summary.live).toBe(false);
    expect(summary.latestWorking).toBeNull();
  });
});
