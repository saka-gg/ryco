import { expect, it } from "vitest";
import { Effect } from "effect";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@ryco/contracts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
it("publishes imported messages and archive provenance atomically without starting provider turns", async () => {
  const at = "2026-01-01T00:00:00.000Z",
    projectId = ProjectId.make("fixture"),
    threadId = ThreadId.make("imported");
  const readModel = await Effect.runPromise(
    projectEvent(createEmptyReadModel(at), {
      sequence: 1,
      eventId: EventId.make("project"),
      commandId: CommandId.make("project"),
      causationEventId: null,
      correlationId: null,
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: at,
      type: "project.created",
      metadata: {},
      payload: {
        projectId,
        title: "Fixture",
        workspaceRoot: "/fixture",
        defaultModelSelection: null,
        scripts: [],
        createdAt: at,
        updatedAt: at,
      },
    }),
  );
  const command: OrchestrationCommand = {
    type: "thread.history.import",
    commandId: CommandId.make("import"),
    threadId,
    projectId,
    title: "Imported",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: at,
    archived: true,
    source: "codex",
    messages: [
      {
        id: MessageId.make("legacy-user"),
        role: "user",
        text: "Question",
        turnId: TurnId.make("legacy-turn"),
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: MessageId.make("legacy-answer"),
        role: "assistant",
        text: "Answer",
        turnId: TurnId.make("legacy-turn"),
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    ],
  };
  const events = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  expect(Array.isArray(events)).toBe(true);
  if (!Array.isArray(events)) return;
  expect(events.map((event) => event.type)).toEqual([
    "thread.created",
    "thread.message-sent",
    "thread.message-sent",
    "thread.activity-appended",
    "thread.archived",
  ]);
  const assistant = events[2]!;
  if (assistant.type === "thread.message-sent")
    expect(assistant.payload).toMatchObject({
      streaming: false,
      turnId: "legacy-turn",
      role: "assistant",
    });
  let projected = readModel;
  for (const [index, event] of events.entries())
    projected = await Effect.runPromise(projectEvent(projected, { ...event, sequence: index + 2 }));
  expect(
    (
      await Effect.runPromise(
        Effect.exit(decideOrchestrationCommand({ command, readModel: projected })),
      )
    )._tag,
  ).toBe("Failure");
});
