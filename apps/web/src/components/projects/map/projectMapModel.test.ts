import type { AgentControlProposal } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fixtureAutomation } from "../testing/automationFixtures";
import { pendingScheduleChanges } from "./projectMapModel";

const proposal = (
  id: string,
  plan: Record<string, unknown>,
  status = "pending-user-approval",
): AgentControlProposal => ({ proposalId: id, status, plan }) as unknown as AgentControlProposal;

describe("pending schedule changes", () => {
  const automation = fixtureAutomation({ id: "auto-1", title: "Triage", nextInMinutes: 5 });
  const before = {
    revision: automation.revision,
    definition: automation.definition,
    cancelled: false,
    updatedAt: automation.updatedAt,
  };

  it("names a pause, a resume, an edit, a cancel and a new schedule", () => {
    const paused = { ...automation.definition, enabled: false };
    const renamed = {
      ...automation.definition,
      execution: { ...automation.definition.execution, title: "Triage everything" },
    };
    expect(
      pendingScheduleChanges([
        proposal("p-pause", {
          kind: "updateAutomation",
          automationId: "auto-1",
          before,
          after: paused,
        }),
        proposal("p-resume", {
          kind: "updateAutomation",
          automationId: "auto-1",
          before: { ...before, definition: paused },
          after: automation.definition,
        }),
        proposal("p-edit", {
          kind: "updateAutomation",
          automationId: "auto-1",
          before,
          after: renamed,
        }),
        proposal("p-cancel", {
          kind: "cancelAutomation",
          automationId: "auto-1",
          expected: before,
        }),
        proposal("p-new", {
          kind: "createAutomation",
          automationId: "auto-2",
          definition: automation.definition,
        }),
      ]).map((change) => [change.label, change.automationId, change.title]),
    ).toEqual([
      ["Pause", "auto-1", "Triage"],
      ["Resume", "auto-1", "Triage"],
      ["Update", "auto-1", "Triage everything"],
      ["Cancel schedule", "auto-1", "Triage"],
      ["New schedule", null, "Triage"],
    ]);
  });

  it("ignores decided proposals and other plans", () => {
    expect(
      pendingScheduleChanges([
        proposal(
          "p-done",
          { kind: "cancelAutomation", automationId: "auto-1", expected: before },
          "completed",
        ),
        proposal("p-other", { kind: "sendMessage" }),
      ]),
    ).toEqual([]);
  });
});
