import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadCreatedPayload,
} from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { MAX_THREAD_LINEAGE_DEPTH } from "./threadLineage.ts";

const AT = "2026-10-01T00:00:00.000Z";
const PROJECT = ProjectId.make("project-lineage");
const OTHER_PROJECT = ProjectId.make("project-lineage-other");

type ThreadCreate = Extract<OrchestrationCommand, { type: "thread.create" }>;
type ThreadDelegatedCreate = Extract<OrchestrationCommand, { type: "thread.delegated.create" }>;

let sequence = 0;

const projectAll = (
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) =>
  Effect.gen(function* () {
    let next = readModel;
    for (const event of events) {
      sequence += 1;
      next = yield* projectEvent(next, { ...event, sequence } as OrchestrationEvent);
    }
    return next;
  });

const decide = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const result = yield* decideOrchestrationCommand({ readModel, command });
    return Array.isArray(result) ? result : [result];
  });

const dispatch = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const events = yield* decide(readModel, command);
    return yield* projectAll(readModel, events);
  });

const projectCreated = (projectId: ProjectId): Omit<OrchestrationEvent, "sequence"> => ({
  eventId: EventId.make(`evt-project-${projectId}`),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: AT,
  commandId: CommandId.make(`cmd-project-${projectId}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    projectId,
    title: projectId,
    workspaceRoot: `/tmp/${projectId}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: AT,
    updatedAt: AT,
  },
});

const threadCreate = (threadId: string, projectId: ProjectId = PROJECT): ThreadCreate => ({
  type: "thread.create",
  commandId: CommandId.make(`cmd-create-${threadId}`),
  threadId: ThreadId.make(threadId),
  projectId,
  title: `Thread ${threadId}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  tokenMode: "balanced",
  branch: "feature/lineage",
  worktreePath: null,
  createdAt: AT,
});

const delegatedCreate = (
  threadId: string,
  parentThreadId: string,
  projectId: ProjectId = PROJECT,
): ThreadDelegatedCreate => ({
  ...threadCreate(threadId, projectId),
  type: "thread.delegated.create",
  commandId: CommandId.make(`cmd-delegate-${threadId}-${parentThreadId}`),
  parentThreadId: ThreadId.make(parentThreadId),
});

const deleteThread = (threadId: string): OrchestrationCommand => ({
  type: "thread.delete",
  commandId: CommandId.make(`cmd-delete-${threadId}`),
  threadId: ThreadId.make(threadId),
});

const seed = Effect.gen(function* () {
  const base = yield* projectAll(createEmptyReadModel(AT), [
    projectCreated(PROJECT),
    projectCreated(OTHER_PROJECT),
  ]);
  return yield* dispatch(base, threadCreate("parent"));
});

const createdPayload = (
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
): typeof ThreadCreatedPayload.Type => {
  assert.strictEqual(events.length, 1);
  const event = events[0]!;
  if (event.type !== "thread.created") {
    assert.fail(`Expected thread.created, got ${event.type}`);
  }
  // Planned events omit `sequence`, which loses the type/payload correlation.
  return event.payload as typeof ThreadCreatedPayload.Type;
};

const expectInvariant = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(decide(readModel, command));
    assert.instanceOf(error, OrchestrationCommandInvariantError);
    assert.strictEqual(error.commandType, "thread.delegated.create");
    return error;
  });

describe("decider thread.delegated.create lineage", () => {
  it.effect("records parent and root for a child of a root parent", () =>
    Effect.gen(function* () {
      const readModel = yield* seed;
      const delegated = createdPayload(
        yield* decide(readModel, delegatedCreate("child", "parent")),
      );
      assert.deepStrictEqual(delegated.lineage, {
        parentThreadId: ThreadId.make("parent"),
        rootThreadId: ThreadId.make("parent"),
        relationship: "delegated",
      });

      const plain = createdPayload(yield* decide(readModel, threadCreate("child")));
      const { lineage: _lineage, ...delegatedWithoutLineage } = delegated;
      assert.deepStrictEqual(delegatedWithoutLineage, plain);
    }),
  );

  it.effect("inherits the root from the parent's lineage", () =>
    Effect.gen(function* () {
      const withChild = yield* dispatch(yield* seed, delegatedCreate("child", "parent"));
      const grandchild = createdPayload(
        yield* decide(withChild, delegatedCreate("grandchild", "child")),
      );
      assert.deepStrictEqual(grandchild.lineage, {
        parentThreadId: ThreadId.make("child"),
        rootThreadId: ThreadId.make("parent"),
        relationship: "delegated",
      });
    }),
  );

  it.effect("plain thread.create emits no lineage key", () =>
    Effect.gen(function* () {
      const payload = createdPayload(yield* decide(yield* seed, threadCreate("plain")));
      assert.notProperty(payload, "lineage");
    }),
  );

  it.effect("rejects an unknown parent", () =>
    Effect.gen(function* () {
      yield* expectInvariant(yield* seed, delegatedCreate("child", "missing-parent"));
    }),
  );

  it.effect("rejects a deleted parent", () =>
    Effect.gen(function* () {
      const deleted = yield* dispatch(yield* seed, deleteThread("parent"));
      const error = yield* expectInvariant(deleted, delegatedCreate("child", "parent"));
      assert.include(error.detail, "was deleted");
    }),
  );

  it.effect("accepts an archived parent", () =>
    Effect.gen(function* () {
      const archived = yield* projectAll(yield* seed, [
        {
          eventId: EventId.make("evt-archive-parent"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("parent"),
          type: "thread.archived",
          occurredAt: AT,
          commandId: CommandId.make("cmd-archive-parent"),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { threadId: ThreadId.make("parent"), archivedAt: AT, updatedAt: AT },
        },
      ]);
      const payload = createdPayload(yield* decide(archived, delegatedCreate("child", "parent")));
      assert.strictEqual(payload.lineage?.parentThreadId, "parent");
    }),
  );

  it.effect("rejects a parent in another project", () =>
    Effect.gen(function* () {
      const error = yield* expectInvariant(
        yield* seed,
        delegatedCreate("child", "parent", OTHER_PROJECT),
      );
      assert.include(error.detail, "different project");
    }),
  );

  it.effect("rejects delegating a thread from itself", () =>
    Effect.gen(function* () {
      yield* expectInvariant(yield* seed, delegatedCreate("parent", "parent"));
    }),
  );

  it.effect("rejects a cycle when the re-created id was the parent's parent", () =>
    Effect.gen(function* () {
      // parent -> x -> p; delete x; re-create x under p.
      let readModel = yield* dispatch(yield* seed, delegatedCreate("x", "parent"));
      readModel = yield* dispatch(readModel, delegatedCreate("p", "x"));
      readModel = yield* dispatch(readModel, deleteThread("x"));
      const error = yield* expectInvariant(readModel, delegatedCreate("x", "p"));
      assert.include(error.detail, "cycle");
    }),
  );

  it.effect("rejects a cycle when the re-created id was the root", () =>
    Effect.gen(function* () {
      // parent -> m -> p; delete the root; re-create it under p.
      let readModel = yield* dispatch(yield* seed, delegatedCreate("m", "parent"));
      readModel = yield* dispatch(readModel, delegatedCreate("p", "m"));
      readModel = yield* dispatch(readModel, deleteThread("parent"));
      const error = yield* expectInvariant(readModel, delegatedCreate("parent", "p"));
      assert.include(error.detail, "cycle");
    }),
  );

  it.effect("rejects a cycle when the re-created id was a middle ancestor", () =>
    Effect.gen(function* () {
      // parent -> x -> m -> p; delete x; re-create x under p. Neither the
      // parent's parent nor the root is x, only the full walk finds it.
      let readModel = yield* dispatch(yield* seed, delegatedCreate("x", "parent"));
      readModel = yield* dispatch(readModel, delegatedCreate("m", "x"));
      readModel = yield* dispatch(readModel, delegatedCreate("p", "m"));
      readModel = yield* dispatch(readModel, deleteThread("x"));
      const error = yield* expectInvariant(readModel, delegatedCreate("x", "p"));
      assert.include(error.detail, "cycle");
    }),
  );

  it.effect("rejects an ancestor chain deeper than the maximum depth", () =>
    Effect.gen(function* () {
      let readModel = yield* seed;
      let parent = "parent";
      // The deepest allowed thread has MAX_THREAD_LINEAGE_DEPTH ancestors.
      for (let depth = 1; depth <= MAX_THREAD_LINEAGE_DEPTH; depth += 1) {
        const child = `depth-${depth}`;
        readModel = yield* dispatch(readModel, delegatedCreate(child, parent));
        parent = child;
      }
      const deepest = readModel.threads.find((thread) => thread.id === parent);
      assert.strictEqual(deepest?.lineage?.rootThreadId, "parent");
      const error = yield* expectInvariant(readModel, delegatedCreate("too-deep", parent));
      assert.include(error.detail, "maximum depth");
    }),
  );
});
