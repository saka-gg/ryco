import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@ryco/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-10-24T00:00:00.000Z";
const projectId = ProjectId.make("project-branch-precondition");
const threadId = ThreadId.make("thread-branch-precondition");
const worktreeId = WorktreeId.make("worktree-branch-precondition");

let sequence = 0;
const event = (
  input: Pick<OrchestrationEvent, "type" | "payload" | "aggregateKind" | "aggregateId">,
): OrchestrationEvent =>
  ({
    ...input,
    sequence: ++sequence,
    eventId: EventId.make(`evt-branch-${sequence}`),
    occurredAt: NOW,
    commandId: CommandId.make(`cmd-branch-${sequence}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-branch-${sequence}`),
    metadata: {},
  }) as OrchestrationEvent;

async function apply(model: OrchestrationReadModel, events: ReadonlyArray<OrchestrationEvent>) {
  let next = model;
  for (const entry of events) next = await Effect.runPromise(projectEvent(next, entry));
  return next;
}

/** A project, a workspace record on `workspaceBranch` and a thread on `threadBranch` inside it. */
function seed(input: {
  readonly threadBranch: string | null;
  readonly workspaceBranch?: string;
}): Promise<OrchestrationReadModel> {
  return apply(createEmptyReadModel(NOW), [
    event({
      type: "project.created",
      aggregateKind: "project",
      aggregateId: projectId,
      payload: {
        projectId,
        title: "Branch precondition",
        workspaceRoot: "/tmp/branch-precondition",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    event({
      type: "worktree.created",
      aggregateKind: "worktree",
      aggregateId: worktreeId,
      payload: {
        worktreeId,
        projectId,
        branch: input.workspaceBranch ?? "ryco/1234abcd",
        worktreePath: "/tmp/branch-precondition-worktree",
        origin: "branch",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    event({
      type: "thread.created",
      aggregateKind: "thread",
      aggregateId: threadId,
      payload: {
        threadId,
        projectId,
        title: "Branch precondition",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: input.threadBranch,
        worktreePath: "/tmp/branch-precondition-worktree",
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  ]);
}

const threadUpdate = (
  fields: Partial<Extract<OrchestrationCommand, { type: "thread.meta.update" }>>,
): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: CommandId.make("cmd-thread-branch-update"),
  threadId,
  ...fields,
});

const workspaceUpdate = (
  fields: Partial<Extract<OrchestrationCommand, { type: "worktree.meta.update" }>>,
): OrchestrationCommand => ({
  type: "worktree.meta.update",
  commandId: CommandId.make("cmd-workspace-branch-update"),
  worktreeId,
  changedAt: NOW,
  ...fields,
});

function decide(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  return Effect.runPromise(
    decideOrchestrationCommand({ readModel, command }).pipe(
      Effect.match({
        onSuccess: (decided) => ({
          events: Array.isArray(decided) ? decided : [decided],
          error: undefined,
        }),
        onFailure: (error) => ({ events: [], error }),
      }),
    ),
  );
}

function expectBranchRejection(error: unknown, detail: string) {
  expect(Schema.is(OrchestrationCommandInvariantError)(error)).toBe(true);
  const invariant = error as OrchestrationCommandInvariantError;
  expect(invariant.failedPrecondition).toBe("expectedBranch");
  expect(invariant.detail).toContain(detail);
}

describe("thread.meta.update expectedBranch", () => {
  it("applies while the thread records the expected branch", async () => {
    const { events, error } = await decide(
      await seed({ threadBranch: "feat/a" }),
      threadUpdate({ branch: "feat/b", expectedBranch: "feat/a" }),
    );
    expect(error).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "thread.meta-updated",
      payload: { threadId, branch: "feat/b" },
    });
    // The guard is a precondition, never part of the recorded change.
    expect(events[0]?.payload).not.toHaveProperty("expectedBranch");
  });

  it("refuses once the thread records a newer branch, and names it", async () => {
    const { events, error } = await decide(
      await seed({ threadBranch: "feat/c" }),
      threadUpdate({ branch: "feat/b", expectedBranch: "feat/a" }),
    );
    expect(events).toHaveLength(0);
    expectBranchRejection(error, "records branch 'feat/c' now");
  });

  it("applies when the same change landed first", async () => {
    const { events, error } = await decide(
      await seed({ threadBranch: "feat/b" }),
      threadUpdate({ branch: "feat/b", expectedBranch: "feat/a" }),
    );
    expect(error).toBeUndefined();
    expect(events[0]).toMatchObject({ payload: { branch: "feat/b" } });
  });

  it("matches a null expected branch only against a thread without one", async () => {
    const accepted = await decide(
      await seed({ threadBranch: null }),
      threadUpdate({ branch: "feat/b", expectedBranch: null }),
    );
    expect(accepted.error).toBeUndefined();
    expect(accepted.events[0]).toMatchObject({ payload: { branch: "feat/b" } });

    const refused = await decide(
      await seed({ threadBranch: "feat/a" }),
      threadUpdate({ branch: "feat/b", expectedBranch: null }),
    );
    expectBranchRejection(refused.error, "but the update expected no branch");
  });

  it("keeps today's unguarded behaviour without expectedBranch", async () => {
    const model = await seed({ threadBranch: "feat/c" });
    const branchOnly = await decide(model, threadUpdate({ branch: "feat/b" }));
    expect(branchOnly.error).toBeUndefined();
    expect(branchOnly.events[0]).toMatchObject({ payload: { branch: "feat/b" } });

    const titleOnly = await decide(model, threadUpdate({ title: "Renamed" }));
    expect(titleOnly.error).toBeUndefined();
    expect(titleOnly.events[0]?.payload).toMatchObject({ title: "Renamed" });
    expect(titleOnly.events[0]?.payload).not.toHaveProperty("branch");
  });
});

describe("worktree.meta.update expectedBranch", () => {
  it("applies while the workspace records the expected branch", async () => {
    const { events, error } = await decide(
      await seed({ threadBranch: null, workspaceBranch: "feat/a" }),
      workspaceUpdate({ branch: "feat/b", expectedBranch: "feat/a" }),
    );
    expect(error).toBeUndefined();
    expect(events[0]).toMatchObject({
      type: "worktree.metaUpdated",
      payload: { worktreeId, branch: "feat/b" },
    });
    expect(events[0]?.payload).not.toHaveProperty("expectedBranch");
  });

  it("refuses once the workspace records a newer branch", async () => {
    const { events, error } = await decide(
      await seed({ threadBranch: null, workspaceBranch: "feat/c" }),
      workspaceUpdate({ branch: "feat/b", expectedBranch: "feat/a" }),
    );
    expect(events).toHaveLength(0);
    expectBranchRejection(
      error,
      "Workspace 'worktree-branch-precondition' records branch 'feat/c'",
    );
  });

  it("applies when the same change landed first", async () => {
    const { error } = await decide(
      await seed({ threadBranch: null, workspaceBranch: "feat/b" }),
      workspaceUpdate({ branch: "feat/b", expectedBranch: "feat/a" }),
    );
    expect(error).toBeUndefined();
  });

  it("refuses a guarded update of an unknown workspace, as a missing record and not a lost race", async () => {
    const { error } = await decide(
      await seed({ threadBranch: null }),
      workspaceUpdate({
        worktreeId: WorktreeId.make("worktree-unknown"),
        branch: "feat/b",
        expectedBranch: "feat/a",
      }),
    );
    expect(Schema.is(OrchestrationCommandInvariantError)(error)).toBe(true);
    expect((error as OrchestrationCommandInvariantError).failedPrecondition).toBeUndefined();
    expect((error as OrchestrationCommandInvariantError).detail).toContain("does not exist");
  });

  it("keeps today's unguarded behaviour without expectedBranch", async () => {
    const model = await seed({ threadBranch: null, workspaceBranch: "feat/c" });
    const branchOnly = await decide(model, workspaceUpdate({ branch: "feat/b" }));
    expect(branchOnly.error).toBeUndefined();
    expect(branchOnly.events[0]).toMatchObject({ payload: { branch: "feat/b" } });
    // Unknown records stay a projector no-op, as before.
    const unknown = await decide(
      model,
      workspaceUpdate({ worktreeId: WorktreeId.make("worktree-unknown"), title: "Renamed" }),
    );
    expect(unknown.error).toBeUndefined();
  });
});
