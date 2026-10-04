import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { countActiveDesktopTurns, describeActiveDesktopTurns } from "./desktopRelaunchGuard.logic";

const LOCAL = EnvironmentId.make("env-local");
const REMOTE = EnvironmentId.make("env-remote");

let nextId = 0;
function thread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  nextId += 1;
  return {
    id: ThreadId.make(`thread-${nextId}`),
    environmentId: LOCAL,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    interactionMode: "default",
    session: null,
    createdAt: "2026-10-04T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const runningSession = {
  provider: "codex",
  status: "running",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  orchestrationStatus: "running",
} as unknown as NonNullable<SidebarThreadSummary["session"]>;

describe("countActiveDesktopTurns", () => {
  it("counts every local turn a relaunch would stop", () => {
    expect(
      countActiveDesktopTurns(
        [
          thread({ session: runningSession }),
          thread({ hasPendingApprovals: true }),
          thread({ hasPendingUserInput: true }),
          thread({ backgroundLiveness: "working" }),
          thread(),
        ],
        LOCAL,
      ),
    ).toBe(4);
  });

  it("ignores remote, archived, and never-finishing monitoring work", () => {
    expect(
      countActiveDesktopTurns(
        [
          thread({ environmentId: REMOTE, session: runningSession }),
          thread({ archivedAt: "2026-10-04T00:00:00.000Z", session: runningSession }),
          thread({ backgroundLiveness: "monitoring" }),
        ],
        LOCAL,
      ),
    ).toBe(0);
  });

  it("cannot count before the local environment is known", () => {
    // Reading that as zero relaunched without asking while turns ran.
    expect(countActiveDesktopTurns([thread({ session: runningSession })], null)).toBeNull();
    expect(countActiveDesktopTurns([], null)).toBeNull();
  });
});

describe("describeActiveDesktopTurns", () => {
  it("pluralises the running turns", () => {
    expect(describeActiveDesktopTurns(1)).toBe("1 agent turn is still running");
    expect(describeActiveDesktopTurns(3)).toBe("3 agent turns are still running");
    expect(describeActiveDesktopTurns(null)).toBe("Agent turns may still be running");
  });
});
