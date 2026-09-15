import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-09-15T00:00:00.000Z";
const projectId = ProjectId.make("project-token-mode");

async function readModelWithProject() {
  return Effect.runPromise(
    projectEvent(createEmptyReadModel(createdAt), {
      sequence: 1,
      eventId: EventId.make("event-project-token-mode"),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: createdAt,
      commandId: CommandId.make("command-project-token-mode"),
      causationEventId: null,
      correlationId: CommandId.make("command-project-token-mode"),
      metadata: {},
      payload: {
        projectId,
        title: "Token mode",
        workspaceRoot: "/tmp/token-mode",
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    }),
  );
}

function createThreadCommand(
  threadId: string,
  tokenMode?: "off" | "balanced" | "aggressive",
): Extract<OrchestrationCommand, { type: "thread.create" }> {
  return {
    type: "thread.create",
    commandId: CommandId.make(`command-${threadId}`),
    threadId: ThreadId.make(threadId),
    projectId,
    title: "Token mode thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...(tokenMode === undefined ? {} : { tokenMode }),
    branch: null,
    worktreePath: null,
    createdAt,
  };
}

function singleEvent(
  result:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
): Omit<OrchestrationEvent, "sequence"> {
  return (Array.isArray(result) ? result[0] : result) as Omit<OrchestrationEvent, "sequence">;
}

describe("thread token mode defaults", () => {
  it("defaults an omitted thread mode to off", async () => {
    const event = singleEvent(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: await readModelWithProject(),
          command: createThreadCommand("thread-default-off"),
        }),
      ),
    );

    expect(event.type).toBe("thread.created");
    if (event.type !== "thread.created") return;
    expect((event.payload as { readonly tokenMode?: string }).tokenMode).toBe("off");
  });

  it.each(["balanced", "aggressive"] as const)("preserves an explicit %s opt-in", async (mode) => {
    const event = singleEvent(
      await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: await readModelWithProject(),
          command: createThreadCommand(`thread-explicit-${mode}`, mode),
        }),
      ),
    );

    expect(event.type).toBe("thread.created");
    if (event.type !== "thread.created") return;
    expect((event.payload as { readonly tokenMode?: string }).tokenMode).toBe(mode);
  });
});
