import { deriveScheduleRows } from "@ryco/client-runtime/state/agentControl";
import { ProjectId, type AgentControlAutomation, type AutomationCentreRun } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { RYCO_LOCAL } from "../testing/projectFixtures";
import { fixtureAutomation, fixtureRun } from "../testing/automationFixtures";
import { nextRunLabel, toMapAutomation } from "./projectMapModel";

const MINUTE = 60_000;
const realNow = () => performance.timeOrigin + performance.now();

/** The map's schedule, read through the dialog's rows as the map does. */
function mapAutomation(
  automation: AgentControlAutomation,
  runs: readonly AutomationCentreRun[],
  nowMs: number,
) {
  const [row] = deriveScheduleRows({
    projectId: ProjectId.make(RYCO_LOCAL),
    snapshot: {
      automations: [automation],
      runs: [...runs],
      proposals: [],
      unavailableRecords: 0,
      historyLimit: 50,
    },
    nowMs,
  });
  const map = row ? toMapAutomation(row, nowMs) : null;
  if (!map) throw new Error("expected a schedule row");
  return map;
}

describe("map automations read like the Automations dialog", () => {
  it("says the schedule and the next run in the dialog's words", () => {
    const automation = fixtureAutomation({
      id: "auto-1",
      title: "Triage",
      everyMinutes: 120,
      nextInMinutes: 30,
    });
    const nowMs = Date.parse(automation.nextRunAt!) - 30 * MINUTE;
    const map = mapAutomation(automation, [], nowMs);
    expect(map.scheduleLabel).toMatch(/^Every 2 h · until /);
    expect(nextRunLabel(map, nowMs)).toBe("in 30m");
    expect(
      nextRunLabel(
        { stateLabel: "", nextRunAt: new Date(nowMs + 3 * 24 * 60 * MINUTE).toISOString() },
        nowMs,
      ),
    ).toBe("in 3 days");
  });

  it("says Paused only for a paused schedule; a finished one is Finished", () => {
    const nowMs = realNow();
    const paused = mapAutomation(
      fixtureAutomation({ id: "auto-p", title: "Paused", nextInMinutes: null, enabled: false }),
      [],
      nowMs,
    );
    expect(nextRunLabel(paused, nowMs)).toBe("Paused");
    const finished = mapAutomation(
      fixtureAutomation({ id: "auto-f", title: "Finished", nextInMinutes: null }),
      [],
      nowMs,
    );
    expect(finished.enabled).toBe(true);
    expect(nextRunLabel(finished, nowMs)).toBe("Finished");
    // A once schedule whose run waits for approval has no next run either.
    const waiting = mapAutomation(
      fixtureAutomation({ id: "auto-w", title: "Waiting", nextInMinutes: null }),
      [
        fixtureRun({
          id: "run-w",
          automationId: "auto-w",
          status: "pending-approval",
          minutesAgo: 1,
          proposalId: "proposal-w",
        }),
      ],
      nowMs,
    );
    expect(nextRunLabel(waiting, nowMs)).toBe("Waiting for approval");
  });

  it("folds runs in: the waiting one to approve, one starting, and a failure since", () => {
    const automation = fixtureAutomation({ id: "auto-1", title: "Triage", nextInMinutes: 5 });
    const runs = [
      fixtureRun({
        id: "run-due",
        automationId: "auto-1",
        status: "pending-approval",
        minutesAgo: 1,
        proposalId: "proposal-due",
      }),
      fixtureRun({ id: "run-go", automationId: "auto-1", status: "executing", minutesAgo: 2 }),
      fixtureRun({ id: "run-bad", automationId: "auto-1", status: "failed", minutesAgo: 60 }),
      fixtureRun({ id: "run-other", automationId: "auto-2", status: "completed", minutesAgo: 3 }),
    ];
    const map = mapAutomation(automation, runs, realNow());
    expect(map.pendingProposalId).toBe("proposal-due");
    expect(map.running).toBe(true);
    expect(map.lastRunFailed).toBe(true);
    expect(map.stateLabel).toBe("Waiting for approval");
  });
});
