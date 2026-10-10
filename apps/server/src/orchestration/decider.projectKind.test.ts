import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ProjectKind,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-10-08T10:00:00.000Z";
const projectId = ProjectId.make("project-kind");

const decide = (
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
  readModel: OrchestrationReadModel,
) =>
  Effect.runPromise(decideOrchestrationCommand({ command, readModel })).then((result) =>
    Array.isArray(result) ? result[0]! : result,
  );

/** Projects a decided event onto the read model the way the engine does. */
const apply = (
  readModel: OrchestrationReadModel,
  event: Awaited<ReturnType<typeof decide>>,
  sequence: number,
) =>
  Effect.runPromise(
    projectEvent(readModel, {
      ...event,
      sequence,
      eventId: EventId.make(`evt-${sequence}`),
    } as OrchestrationEvent),
  );

const createProject = async (kind?: ProjectKind) => {
  const created = await decide(
    {
      type: "project.create",
      commandId: CommandId.make(`create-${kind ?? "default"}`),
      projectId,
      ...(kind !== undefined ? { kind } : {}),
      title: "Kind",
      workspaceRoot: "/tmp/project-kind",
      createdAt: now,
    },
    createEmptyReadModel(now),
  );
  return { created, readModel: await apply(createEmptyReadModel(now), created, 1) };
};

const updateKind = (readModel: OrchestrationReadModel, kind: ProjectKind) =>
  decide(
    {
      type: "project.meta.update",
      commandId: CommandId.make(`update-${kind}`),
      projectId,
      kind,
    },
    readModel,
  );

describe("decider project kind", () => {
  it("creates a regular project unless a kind is given", async () => {
    const { created, readModel } = await createProject();
    expect(created.type).toBe("project.created");
    expect((created.payload as { kind?: ProjectKind }).kind).toBe("project");
    expect(readModel.projects[0]?.kind).toBe("project");
  });

  it("creates a chat project and promotes it to a project", async () => {
    const { created, readModel } = await createProject("chat");
    expect((created.payload as { kind?: ProjectKind }).kind).toBe("chat");
    expect(readModel.projects[0]?.kind).toBe("chat");

    const promoted = await updateKind(readModel, "project");
    expect(promoted.type).toBe("project.meta-updated");
    expect((promoted.payload as { kind?: ProjectKind }).kind).toBe("project");
    const next = await apply(readModel, promoted, 2);
    expect(next.projects[0]?.kind).toBe("project");
  });

  it("treats an unchanged kind as a no-op", async () => {
    const { readModel } = await createProject("chat");
    const unchanged = await updateKind(readModel, "chat");
    expect(unchanged.type).toBe("project.meta-updated");
    expect(unchanged.payload).not.toHaveProperty("kind");
    expect((await apply(readModel, unchanged, 2)).projects[0]?.kind).toBe("chat");
  });

  it("never turns a project into a chat", async () => {
    const { readModel } = await createProject("project");
    await expect(updateKind(readModel, "chat")).rejects.toThrow(
      "cannot change kind from 'project' to 'chat'",
    );
  });

  it("never changes a retired chat or adds a thread to it", async () => {
    const { readModel: live } = await createProject("chat");
    const deleted = await decide(
      { type: "project.delete", commandId: CommandId.make("retire-chat"), projectId },
      live,
    );
    expect(deleted.type).toBe("project.deleted");
    const retired = await apply(live, deleted, 2);
    // The read model keeps the record, so its history still resolves.
    expect(retired.projects[0]?.deletedAt).not.toBeNull();

    // Pointing a retired chat at another chat's folder would let its folder deletion remove
    // that chat's files.
    await expect(
      decide(
        {
          type: "project.meta.update",
          commandId: CommandId.make("retarget-retired-chat"),
          projectId,
          workspaceRoot: "/tmp/chats/2026-10-08-other-chat-0a1b2c3d",
        },
        retired,
      ),
    ).rejects.toThrow("was removed");
    await expect(
      decide(
        {
          type: "project.avatar.set",
          commandId: CommandId.make("avatar-retired-chat"),
          projectId,
          contentHash: "a".repeat(64),
        },
        retired,
      ),
    ).rejects.toThrow("was removed");
    // A first send that loses the race with the chat's retirement fails instead of creating
    // an invisible thread without a folder.
    await expect(
      decide(
        {
          type: "thread.create",
          commandId: CommandId.make("thread-in-retired-chat"),
          threadId: ThreadId.make("thread-retired-chat"),
          projectId,
          title: "Chat",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        retired,
      ),
    ).rejects.toThrow("was removed");
  });

  it("reads projects created before kinds existed as regular projects", async () => {
    const legacy = await Effect.runPromise(
      projectEvent(createEmptyReadModel(now), {
        sequence: 1,
        eventId: EventId.make("evt-legacy"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("legacy-create"),
        causationEventId: null,
        correlationId: CommandId.make("legacy-create"),
        metadata: {},
        payload: {
          projectId,
          title: "Legacy",
          workspaceRoot: "/tmp/legacy",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    expect(legacy.projects[0]?.kind).toBe("project");
    await expect(updateKind(legacy, "chat")).rejects.toThrow("cannot change kind");
  });
});
