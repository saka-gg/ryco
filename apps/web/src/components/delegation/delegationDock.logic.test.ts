import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import {
  AgentControlProposal,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import type { AgentControlCompletionReturn } from "@ryco/contracts/agent-control";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDelegationDockChildren,
  buildDelegationDockLog,
  formatDelegationDockAge,
  summarizeDelegationDock,
} from "./delegationDock.logic";

const PARENT = ThreadId.make("parent");

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("env"),
    projectId: ProjectId.make("project"),
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-10-16T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    lineage: { parentThreadId: PARENT, rootThreadId: PARENT, relationship: "delegated" },
    ...overrides,
  };
}

const turn = (state: "running" | "completed", at: string) => ({
  turnId: TurnId.make(`turn-${at}`),
  state,
  requestedAt: at,
  startedAt: at,
  completedAt: state === "completed" ? at : null,
  assistantMessageId: null,
});

function result(
  child: string,
  status: AgentControlCompletionReturn["status"],
): AgentControlCompletionReturn {
  return {
    revision: 1,
    childThreadId: ThreadId.make(child),
    initialMessageId: MessageId.make(`initial-${child}`),
    parentThreadId: PARENT,
    parentTurnId: TurnId.make("origin"),
    childTurnId: null,
    status,
    detail: `${status} detail`,
    updatedAt: "2026-10-16T10:00:00.000Z",
  };
}

describe("buildDelegationDockChildren", () => {
  it("names each child's state the way the dock shows it", () => {
    const children = buildDelegationDockChildren(
      [
        thread("working", { latestTurn: turn("running", "2026-10-16T10:01:00.000Z") }),
        thread("asking", { hasPendingApprovals: true }),
        thread("done", { latestTurn: turn("completed", "2026-10-16T10:02:00.000Z") }),
        thread("fresh"),
        thread("failed", {
          session: {
            provider: ProviderDriverKind.make("codex"),
            status: "error",
            orchestrationStatus: "error",
            lastError: "Provider exited",
            createdAt: "2026-10-16T10:00:00.000Z",
            updatedAt: "2026-10-16T10:00:00.000Z",
          },
        }),
      ],
      new Map(),
    );
    expect(
      children.map(({ label, tone, runningSince, finishedAt }) => ({
        label,
        tone,
        runningSince,
        finishedAt,
      })),
    ).toEqual([
      {
        label: "Working",
        tone: "working",
        runningSince: "2026-10-16T10:01:00.000Z",
        finishedAt: null,
      },
      { label: "Needs approval", tone: "attention", runningSince: null, finishedAt: null },
      {
        label: "Done",
        tone: "done",
        runningSince: null,
        finishedAt: "2026-10-16T10:02:00.000Z",
      },
      { label: "Idle", tone: "muted", runningSince: null, finishedAt: null },
      { label: "Error", tone: "danger", runningSince: null, finishedAt: null },
    ]);
  });

  it("labels result returns and counts only children that return", () => {
    const children = buildDelegationDockChildren(
      [
        thread("working", { backgroundLiveness: "working" }),
        thread("returned"),
        thread("blocked"),
        thread("unreturned", { hasPendingUserInput: true }),
      ],
      new Map([
        [ThreadId.make("working"), result("working", "waiting")],
        [ThreadId.make("returned"), result("returned", "delivered")],
        [ThreadId.make("blocked"), result("blocked", "blocked")],
      ]),
    );
    expect(children.map((child) => child.result?.label ?? null)).toEqual([
      "Result pending",
      "Returned",
      "Return blocked",
      null,
    ]);
    expect(children[2]?.result).toMatchObject({ tone: "danger", detail: "blocked detail" });
    // Background work has no turn clock.
    expect(children[0]?.runningSince).toBeNull();
    expect(summarizeDelegationDock(children)).toEqual({
      working: 1,
      needsYou: 1,
      failed: 1,
      returned: 1,
      returning: 3,
    });
  });
});

describe("buildDelegationDockLog", () => {
  const proposal = (id: string, status: string) =>
    Schema.decodeUnknownSync(AgentControlProposal)({
      proposalId: id,
      requestId: `request-${id}`,
      principal: { kind: "provider-session", threadId: PARENT, providerInstanceId: "codex" },
      planVersion: 1,
      plan: { kind: "sendMessage", threadId: "child", text: "Hidden prompt", delivery: "queue" },
      planDigest: "a".repeat(64),
      riskTags: [],
      promptSummary: "Send a message",
      status,
      createdAt: "2026-10-16T10:00:00.000Z",
      updatedAt: "2026-10-16T10:05:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      decidedAt: null,
      result: null,
    });

  it("is one line per action and names the status only when it did not complete", () => {
    const rows = buildDelegationDockLog(
      [proposal("done", "completed"), proposal("broke", "failed")],
      (id) => (id === "child" ? "Count lines" : undefined),
    );
    expect(
      rows.map(({ action, target, status, tone }) => ({ action, target, status, tone })),
    ).toEqual([
      { action: "Queue message", target: "Count lines", status: null, tone: "success" },
      { action: "Queue message", target: "Count lines", status: "Failed", tone: "danger" },
    ]);
    expect(JSON.stringify(rows.map(({ proposal: _proposal, ...row }) => row))).not.toContain(
      "Hidden prompt",
    );
  });
});

it("formats quiet ages", () => {
  const now = Date.parse("2026-10-16T12:00:00.000Z");
  expect(formatDelegationDockAge("2026-10-16T11:59:30.000Z", now)).toBe("now");
  expect(formatDelegationDockAge("2026-10-16T11:56:00.000Z", now)).toBe("4m ago");
  expect(formatDelegationDockAge("2026-10-16T09:00:00.000Z", now)).toBe("3h ago");
});
