import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ProviderInstanceId,
  WorktreeId,
} from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asWorktreeId = (value: string): WorktreeId => WorktreeId.make(value);

async function seedReadModel(): Promise<OrchestrationReadModel> {
  const now = new Date().toISOString();
  const initial = createEmptyReadModel(now);
  const withProject = await Effect.runPromise(
    projectEvent(initial, {
      sequence: 1,
      eventId: asEventId("evt-project-create"),
      aggregateKind: "project",
      aggregateId: asProjectId("project-delete"),
      type: "project.created",
      occurredAt: now,
      commandId: asCommandId("cmd-project-create"),
      causationEventId: null,
      correlationId: asCommandId("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: asProjectId("project-delete"),
        title: "Project Delete",
        workspaceRoot: "/tmp/project-delete",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  const withFirstThread = await Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: asEventId("evt-thread-create-1"),
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-delete-1"),
      type: "thread.created",
      occurredAt: now,
      commandId: asCommandId("cmd-thread-create-1"),
      causationEventId: null,
      correlationId: asCommandId("cmd-thread-create-1"),
      metadata: {},
      payload: {
        threadId: asThreadId("thread-delete-1"),
        projectId: asProjectId("project-delete"),
        title: "Thread Delete 1",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  return Effect.runPromise(
    projectEvent(withFirstThread, {
      sequence: 3,
      eventId: asEventId("evt-thread-create-2"),
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-delete-2"),
      type: "thread.created",
      occurredAt: now,
      commandId: asCommandId("cmd-thread-create-2"),
      causationEventId: null,
      correlationId: asCommandId("cmd-thread-create-2"),
      metadata: {},
      payload: {
        threadId: asThreadId("thread-delete-2"),
        projectId: asProjectId("project-delete"),
        title: "Thread Delete 2",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function normalizeDeleteEvent(event: PlannedEvent | ReadonlyArray<PlannedEvent>) {
  const events = Array.isArray(event) ? event : [event];
  return events.map((entry) => {
    switch (entry.type) {
      case "thread.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            threadId: entry.payload.threadId,
          },
        };
      case "project.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            projectId: entry.payload.projectId,
          },
        };
      case "worktree.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            worktreeId: entry.payload.worktreeId,
          },
        };
      default:
        return entry;
    }
  });
}

describe("decider deletion flows", () => {
  it("rejects deleting a non-empty project without force", async () => {
    const readModel = await seedReadModel();

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-no-force"),
            projectId: asProjectId("project-delete"),
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("cannot be deleted without force=true");
  });

  it("moves a force-removed project's conversations to Trash instead of deleting them", async () => {
    const readModel = await seedReadModel();
    const projectUpdatedAt = readModel.projects.find(
      (project) => project.id === asProjectId("project-delete"),
    )!.updatedAt;

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-stale-revision"),
            projectId: asProjectId("project-delete"),
            force: true,
            expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
            expectedThreadIds: [asThreadId("thread-delete-1"), asThreadId("thread-delete-2")],
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("changed after the command was authorized");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-stale-threads"),
            projectId: asProjectId("project-delete"),
            force: true,
            expectedUpdatedAt: projectUpdatedAt,
            expectedThreadIds: [asThreadId("thread-delete-1")],
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("thread set changed after the command was authorized");

    const forcedResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.delete",
          commandId: asCommandId("cmd-project-delete-force"),
          projectId: asProjectId("project-delete"),
          force: true,
          expectedUpdatedAt: projectUpdatedAt,
          expectedThreadIds: [asThreadId("thread-delete-1"), asThreadId("thread-delete-2")],
        },
        readModel,
      }),
    );
    const forcedEvents = Array.isArray(forcedResult) ? forcedResult : [forcedResult];
    expect(forcedEvents.map((event) => event.type)).toEqual([
      "thread.trashed",
      "thread.trashed",
      "project.deleted",
    ]);

    let projected = readModel;
    for (const event of forcedEvents)
      projected = await Effect.runPromise(
        projectEvent(projected, { ...event, sequence: projected.snapshotSequence + 1 }),
      );
    // Hidden like a deletion, but recoverable: nothing was deleted permanently.
    expect(projected.threads.every((thread) => thread.deletedAt !== null)).toBe(true);
    expect(projected.threads.every((thread) => thread.trashedAt != null)).toBe(true);
    // Restoring needs the project back; the conversation stays in Trash meanwhile.
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.untrash",
            commandId: asCommandId("cmd-untrash-orphan"),
            threadId: asThreadId("thread-delete-1"),
          },
          readModel: projected,
        }),
      ),
    ).rejects.toThrow("project was removed");
  });

  it("never deletes conversations or drops a workspace record they reference", async () => {
    const now = new Date().toISOString();
    const worktreeId = asWorktreeId("worktree-delete-1");
    let readModel = await seedReadModel();

    for (const nextEvent of [
      {
        sequence: 4,
        eventId: asEventId("evt-worktree-create"),
        aggregateKind: "worktree",
        aggregateId: worktreeId,
        type: "worktree.created",
        occurredAt: now,
        commandId: asCommandId("cmd-worktree-create"),
        causationEventId: null,
        correlationId: asCommandId("cmd-worktree-create"),
        metadata: {},
        payload: {
          worktreeId,
          projectId: asProjectId("project-delete"),
          branch: "feature/delete-worktree",
          worktreePath: "/tmp/project-delete-worktree",
          origin: "branch",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      ...(["thread-delete-1", "thread-delete-2"] as const).map(
        (threadId, index) =>
          ({
            sequence: 5 + index,
            eventId: asEventId(`evt-thread-attach-${index}`),
            aggregateKind: "thread",
            aggregateId: asThreadId(threadId),
            type: "thread.attachedToWorktree",
            occurredAt: now,
            commandId: asCommandId(`cmd-thread-attach-${index}`),
            causationEventId: null,
            correlationId: asCommandId(`cmd-thread-attach-${index}`),
            metadata: {},
            payload: { threadId: asThreadId(threadId), worktreeId, attachedAt: now },
          }) satisfies OrchestrationEvent,
      ),
    ] satisfies OrchestrationEvent[]) {
      readModel = await Effect.runPromise(projectEvent(readModel, nextEvent));
    }

    const deleteCommand = (sessions?: "preserve" | "delete") =>
      ({
        type: "worktree.delete",
        commandId: asCommandId(`cmd-worktree-delete-${sessions ?? "default"}`),
        worktreeId,
        ...(sessions ? { sessions } : {}),
        deletedAt: now,
        deletedBranch: false,
      }) satisfies OrchestrationCommand;

    for (const sessions of [undefined, "preserve"] as const)
      await expect(
        Effect.runPromise(
          decideOrchestrationCommand({ command: deleteCommand(sessions), readModel }),
        ),
      ).rejects.toThrow("still records 2 conversation(s)");
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({ command: deleteCommand("delete"), readModel }),
      ),
    ).rejects.toThrow("never delete conversations");

    // Trashed conversations still reference it; only permanently deleted ones do not.
    let emptied = readModel;
    for (const threadId of ["thread-delete-1", "thread-delete-2"])
      for (const type of ["thread.trash", "thread.delete"] as const) {
        const decided = await Effect.runPromise(
          decideOrchestrationCommand({
            command: {
              type,
              commandId: asCommandId(`${type}-${threadId}`),
              threadId: asThreadId(threadId),
            },
            readModel: emptied,
          }),
        );
        for (const event of Array.isArray(decided) ? decided : [decided])
          emptied = await Effect.runPromise(
            projectEvent(emptied, { ...event, sequence: emptied.snapshotSequence + 1 }),
          );
        if (type === "thread.trash")
          await expect(
            Effect.runPromise(
              decideOrchestrationCommand({ command: deleteCommand(), readModel: emptied }),
            ),
          ).rejects.toThrow("conversation(s)");
      }
    const result = await Effect.runPromise(
      decideOrchestrationCommand({ command: deleteCommand(), readModel: emptied }),
    );
    expect(normalizeDeleteEvent(result)).toEqual([
      {
        type: "worktree.deleted",
        aggregateKind: "worktree",
        aggregateId: worktreeId,
        commandId: asCommandId("cmd-worktree-delete-default"),
        correlationId: asCommandId("cmd-worktree-delete-default"),
        payload: { worktreeId },
      },
    ]);
  });
});

it("governed checkout removal keeps conversations attached with their provenance", async () => {
  const model = await seedReadModel();
  const project = model.projects[0]!;
  const targetId = asWorktreeId("governed-target");
  const base = {
    projectId: project.id,
    branch: "topic",
    worktreePath: "/tmp/governed-target",
    origin: "manual" as const,
    prNumber: null,
    issueNumber: null,
    prTitle: null,
    issueTitle: null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: null,
    manualPosition: 0,
  };
  const readModel: OrchestrationReadModel = {
    ...model,
    worktrees: [{ ...base, worktreeId: targetId }],
    threads: model.threads.map((t) =>
      Object.assign({}, t, { worktreeId: targetId, worktreePath: base.worktreePath }),
    ),
  };
  const command = {
    type: "worktree.checkout.remove" as const,
    commandId: asCommandId("governed-remove"),
    worktreeId: targetId,
    reason: "removed" as const,
    removedAt: project.updatedAt,
    lifecycleGuard: {
      mainWorkspaceId: null,
      projectId: project.id,
      projectUpdatedAt: project.updatedAt,
      workspaceRoot: project.workspaceRoot,
      updatedAt: base.updatedAt,
      worktreePath: base.worktreePath,
      branch: base.branch,
      sessions: readModel.threads
        .map((t) => ({ threadId: t.id, updatedAt: t.updatedAt }))
        .toSorted((a, b) => a.threadId.localeCompare(b.threadId)),
    },
  };
  const result = await Effect.runPromise(decideOrchestrationCommand({ readModel, command }));
  const events = Array.isArray(result) ? result : [result];
  expect(events.map((e) => e.type)).toEqual(["worktree.checkoutRemoved", "worktree.archived"]);
  let projected = readModel;
  for (const event of events)
    projected = await Effect.runPromise(
      projectEvent(projected, { ...event, sequence: projected.snapshotSequence + 1 }),
    );
  // Never reattached to main, never cleared to the project root, never deleted.
  expect(
    projected.threads.every(
      (t) =>
        t.deletedAt === null && t.worktreeId === targetId && t.worktreePath === base.worktreePath,
    ),
  ).toBe(true);
  const worktree = projected.worktrees?.find((w) => w.worktreeId === targetId);
  expect(worktree).toMatchObject({
    branch: "topic",
    worktreePath: base.worktreePath,
    checkoutRemovalReason: "removed",
  });
  expect(worktree?.archivedAt).not.toBeNull();
  await expect(
    Effect.runPromise(
      decideOrchestrationCommand({
        readModel: { ...readModel, threads: readModel.threads.slice(1) },
        command,
      }),
    ),
  ).rejects.toThrow("changed after approval");
  await expect(
    Effect.runPromise(
      decideOrchestrationCommand({
        readModel: {
          ...readModel,
          worktrees: readModel.worktrees?.map((w) =>
            Object.assign({}, w, { worktreePath: "/tmp/changed" }),
          ),
        },
        command,
      }),
    ),
  ).rejects.toThrow("changed after approval");
});
