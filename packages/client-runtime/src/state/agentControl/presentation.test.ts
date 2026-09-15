import { describe, expect, it } from "vite-plus/test";
import {
  AgentControlProposalId,
  AgentControlRequestId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorktreeId,
  type AgentControlProposal,
} from "@ryco/contracts";

import { buildAgentControlProposalCardModel } from "./presentation.ts";

function makeProposal(overrides: Partial<AgentControlProposal> = {}): AgentControlProposal {
  return {
    proposalId: AgentControlProposalId.make("proposal-1"),
    requestId: AgentControlRequestId.make("request-1"),
    principal: {
      kind: "provider-session",
      threadId: ThreadId.make("thread-caller-1234"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    planVersion: 1,
    plan: {
      kind: "sendMessage",
      threadId: ThreadId.make("thread-target-5678"),
      text: "Continue with the migration.",
      delivery: "queue",
    },
    planDigest: "a".repeat(64),
    riskTags: [],
    promptSummary: "Queue a message",
    status: "pending-user-approval",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-17T01:00:00.000Z",
    decidedAt: null,
    result: null,
    ...overrides,
  };
}

describe("buildAgentControlProposalCardModel", () => {
  it("summarizes a multi-entry createThreads batch with runtime and worktree info", () => {
    const model = buildAgentControlProposalCardModel(
      makeProposal({
        plan: {
          kind: "createThreads",
          entries: [1, 2].map((index) => ({
            projectId: ProjectId.make("project-1"),
            title: `Task ${index}`,
            prompt: `Prompt ${index}`,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
            runtimeMode: "full-access",
            envMode: "worktree",
            baseRef: "main",
          })),
        },
      }),
    );
    expect(model.actionLabel).toBe("Create 2 threads");
    expect(model.targetLabel).toBe("project project-1");
    expect(model.runtimeLabel).toBe("full-access · worktree");
    expect(model.detailSections).toHaveLength(2);
    expect(model.detailSections[0]?.heading).toBe("Thread 1: Task 1");
    expect(model.detailSections[0]?.lines).toContain("Base ref: main");
    expect(model.detailSections[0]?.lines).toContain("Prompt: Prompt 1");
  });

  it("labels sendMessage steering distinctly from queueing", () => {
    const queueModel = buildAgentControlProposalCardModel(makeProposal());
    expect(queueModel.actionLabel).toBe("Queue message");
    expect(queueModel.targetLabel).toBe("thread thread-t…");

    const steerModel = buildAgentControlProposalCardModel(
      makeProposal({
        plan: {
          kind: "sendMessage",
          threadId: ThreadId.make("thread-target-5678"),
          text: "Stop and re-plan.",
          delivery: "steer",
        },
      }),
    );
    expect(steerModel.actionLabel).toBe("Steer thread");
  });

  it("describes interrupt and update plans", () => {
    const interrupt = buildAgentControlProposalCardModel(
      makeProposal({
        plan: {
          kind: "interruptThread",
          threadId: ThreadId.make("thread-target-5678"),
          turnId: TurnId.make("turn-9"),
        },
      }),
    );
    expect(interrupt.actionLabel).toBe("Interrupt thread");
    expect(interrupt.detailSections[0]?.lines).toContain("Only turn: turn-9");

    const update = buildAgentControlProposalCardModel(
      makeProposal({
        plan: {
          kind: "updateThread",
          threadId: ThreadId.make("thread-target-5678"),
          title: "New title",
          archived: true,
          persistentGoal: null,
        },
      }),
    );
    expect(update.actionLabel).toBe("Update thread");
    expect(update.detailSections[0]?.lines).toEqual([
      "Thread: thread-target-5678",
      "Title: New title",
      "Archive thread",
      "Clear persistent goal",
    ]);
  });

  it("shows exact project and allowlisted settings plans", () => {
    const remove = buildAgentControlProposalCardModel(
      makeProposal({
        plan: {
          kind: "removeProject",
          projectId: ProjectId.make("project-1"),
          expected: {
            title: "Project one",
            workspaceRoot: "/workspace/project-one",
            repositoryIdentityKey: "git:example/project-one",
            updatedAt: "2026-08-17T00:00:00.000Z",
          },
          expectedThreadIds: [ThreadId.make("thread-target-5678")],
          force: true,
        },
      }),
    );
    expect(remove.actionLabel).toBe("Unlink project");
    expect(remove.isDestructive).toBe(true);
    expect(remove.detailSections[0]?.lines).toContain(
      "Workspace files and repository contents will be retained.",
    );
    expect(remove.detailSections[0]?.lines).toContain(
      "Ryco thread record removed: thread-target-5678",
    );

    const settings = buildAgentControlProposalCardModel(
      makeProposal({
        plan: {
          kind: "changeSettings",
          change: { kind: "providerUpdateChecks", before: true, after: false },
        },
      }),
    );
    expect(settings.detailSections[0]?.lines).toEqual([
      "Setting: providerUpdateChecks",
      "Before: true",
      "After: false",
      "Fresh owner reauthentication is required at approval and execution.",
    ]);
  });

  it("distinguishes schedule-definition approval from fresh run approval", () => {
    const execution = {
      projectId: ProjectId.make("project-1"),
      title: "Review failures",
      prompt: "Review current failures and summarize.",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
      runtimeMode: "approval-required" as const,
      envMode: "worktree" as const,
    };
    const schedule = {
      kind: "fixed-interval" as const,
      startsAt: "2026-08-18T10:00:00.000Z",
      intervalMs: 900_000,
      endsAt: "2026-08-19T10:00:00.000Z",
    };
    const definition = buildAgentControlProposalCardModel(
      makeProposal({
        plan: {
          kind: "createAutomation",
          automationId: "automation-1" as never,
          definition: { execution, schedule, enabled: true },
        },
      }),
    );
    expect(definition.actionLabel).toBe("Create schedule definition");
    expect(definition.detailSections[0]?.lines).toContain(
      "This approval authorizes only the schedule definition.",
    );
    expect(definition.detailSections[0]?.lines).toContain(
      "Every due run creates a fresh exact proposal and waits for user approval.",
    );

    const run = buildAgentControlProposalCardModel(
      makeProposal({
        plan: {
          kind: "automationRun",
          automationId: "automation-1" as never,
          runId: "automation-run-1" as never,
          automationRevision: 2,
          scheduledFor: "2026-08-18T10:00:00.000Z",
          coalescedOccurrences: 3,
          execution,
        },
      }),
    );
    expect(run.actionLabel).toBe("Approve one scheduled run");
    expect(run.detailSections[0]?.lines).toContain("Missed intervals coalesced: 3");
    expect(run.detailSections[0]?.lines).toContain(
      "Approving the schedule did not approve this run; this exact proposal does.",
    );
  });

  it("shows exact device scope and a high-risk URL warning", () => {
    const model = buildAgentControlProposalCardModel(
      makeProposal({
        plan: {
          kind: "deviceOpenUrl",
          threadId: ThreadId.make("thread-caller-1234"),
          projectId: ProjectId.make("project-1"),
          expectedProjectUpdatedAt: "2026-08-18T00:00:00.000Z",
          providerInstanceId: ProviderInstanceId.make("codex"),
          udid: "FAKE-0001" as never,
          expectedThreadDeviceVersion: 7,
          expectedAttachedDeviceUdid: "FAKE-0001" as never,
          expectedDeviceState: "booted",
          expectedDeviceBootSource: "ryco",
          expectedRecording: false,
          executionSummary: "Open an approved URL or deep link",
          riskClass: "open-world",
          url: "https://example.test/exact-deep-link",
        },
        riskTags: ["device-mutation" as never, "device-open-world" as never],
      }),
    );

    expect(model.warningLabel).toMatch(/High risk/);
    expect(model.runtimeLabel).toBe("high risk · open world");
    expect(model.detailSections[0]?.lines).toContain("Device UDID: FAKE-0001");
    expect(model.detailSections[0]?.lines).toContain("Thread: thread-caller-1234");
    expect(model.detailSections[0]?.lines).toContain(
      "Exact URL/deep link: https://example.test/exact-deep-link",
    );
  });

  it("identifies external integration origins without a caller thread", () => {
    const model = buildAgentControlProposalCardModel(
      makeProposal({
        principal: {
          kind: "external-integration",
          integrationId: "integration-abcdef-123456" as never,
          label: "Local Codex CLI" as never,
        },
      }),
    );
    expect(model.originLabel).toBe("External integration Local Codex CLI");
    expect(model.originThreadId).toBeNull();
  });

  it("labels terminal outcomes from the result envelope", () => {
    const completed = buildAgentControlProposalCardModel(
      makeProposal({
        status: "completed",
        result: {
          outcome: "completed",
          createdThreadIds: [ThreadId.make("thread-new-1")],
          execution: {
            operationId: "operation-123456789" as never,
            commands: [
              {
                commandId: "command-1" as never,
                commandType: "thread.turn.start",
                sequence: 17,
              },
            ],
            affectedThreadIds: [ThreadId.make("thread-new-1")],
            affectedProjectIds: [ProjectId.make("project-1")],
            worktreeIds: [],
            delivery: "queued",
          },
          completedAt: "2026-08-17T00:10:00.000Z",
        },
      }),
    );
    expect(completed.outcomeLabel).toBe("Completed · created 1 thread");
    expect(completed.executionLabel).toBe("Operation operatio… · 1 command · delivery: queued");
    expect(completed.affectedThreadIds).toEqual(["thread-new-1"]);
    expect(completed.affectedProjectIds).toEqual(["project-1"]);
    expect(completed.isPending).toBe(false);

    const failed = buildAgentControlProposalCardModel(
      makeProposal({
        status: "failed",
        result: {
          outcome: "failed",
          error: {
            code: "execution-failed" as never,
            message: "Worktree preflight failed",
            retryable: true,
          },
          failedAt: "2026-08-17T00:10:00.000Z",
        },
      }),
    );
    expect(failed.outcomeLabel).toBe("execution-failed: Worktree preflight failed");
    expect(failed.statusTone).toBe("danger");
  });
});

it("shows the exact workspace path, branch and session consequences before approval", () => {
  const plan: Extract<AgentControlProposal["plan"], { kind: "workspaceLifecycle" }> = {
    kind: "workspaceLifecycle",
    projectId: ProjectId.make("p"),
    action: "delete",
    checkoutMode: "record-only",
    sessions: "preserve",
    deleteBranch: false,
    expected: {
      workspaceId: "workspace",
      worktreeId: WorktreeId.make("workspace"),
      projectId: ProjectId.make("p"),
      registration: "registered",
      mainWorkspaceId: WorktreeId.make("main"),
      checkoutIdentity: null,
      rootIdentity: "1:2",
      repositoryIdentity: "1:3",
      title: "Manual",
      origin: "manual",
      branch: "topic",
      path: "/workspace/missing",
      projectRoot: "/workspace/project",
      projectUpdatedAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
      archivedAt: null,
      main: false,
      current: false,
      checkout: "missing",
      gitRegistered: false,
      repository: "/workspace/project/.git",
      head: null,
      branchHead: "a".repeat(40),
      baseHead: "a".repeat(40),
      dirty: null,
      unmerged: false,
      sessions: [
        {
          threadId: ThreadId.make("history"),
          updatedAt: "2026-09-15T00:00:00.000Z",
          archived: true,
          active: false,
        },
      ],
      blockers: [],
    },
  };
  const preserved = buildAgentControlProposalCardModel(makeProposal({ plan }));
  expect(preserved.isDestructive).toBe(true);
  expect(preserved.detailSections[0]?.lines).toContain("Path: /workspace/missing");
  expect(preserved.detailSections[0]?.lines).toContain("Branch: topic (retain)");
  expect(preserved.detailSections[0]?.lines).toContain(
    "Sessions: preserve history and move to main workspace",
  );
  expect(preserved.detailSections[0]?.lines).toContain("history (archived)");
  const deleted = buildAgentControlProposalCardModel(
    makeProposal({ plan: { ...plan, sessions: "delete" } }),
  );
  expect(deleted.detailSections[0]?.lines).toContain("Sessions: permanently delete history");
});
