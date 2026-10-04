import { CommandId, EventId, ProjectId, WorktreeId } from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionWorktreeRepositoryLive } from "../../persistence/Layers/ProjectionWorktrees.ts";
import { ProjectionWorktreeRepository } from "../../persistence/Services/ProjectionWorktrees.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";

const MockProjectAvatarStoreLive = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

const layer = it.layer(
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ProjectionWorktreeRepositoryLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-worktree-proj-" })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(MockProjectAvatarStoreLive),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("OrchestrationProjectionPipeline worktrees", (it) => {
  it.effect("projects worktree lifecycle events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const worktrees = yield* ProjectionWorktreeRepository;
      const now = "2026-05-08T00:00:00.000Z";
      const archivedAt = "2026-05-09T00:00:00.000Z";
      const worktreeId = WorktreeId.make("worktree-pipeline");

      const created = yield* eventStore.append({
        type: "worktree.created",
        eventId: EventId.make("evt-worktree-created"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-worktree"),
        occurredAt: now,
        commandId: CommandId.make("cmd-worktree-created"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-worktree-created"),
        metadata: {},
        payload: {
          worktreeId,
          projectId: ProjectId.make("project-worktree"),
          branch: "main",
          worktreePath: null,
          origin: "main",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.projectEvent(created);
      const createdRow = yield* worktrees.getById({ worktreeId });
      assert.equal(Option.getOrThrow(createdRow).origin, "main");

      const archived = yield* eventStore.append({
        type: "worktree.archived",
        eventId: EventId.make("evt-worktree-archived"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-worktree"),
        occurredAt: archivedAt,
        commandId: CommandId.make("cmd-worktree-archived"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-worktree-archived"),
        metadata: {},
        payload: {
          worktreeId,
          archivedAt,
          deletedBranch: false,
        },
      });

      yield* projectionPipeline.projectEvent(archived);
      const archivedRow = yield* worktrees.getById({ worktreeId });
      assert.equal(Option.getOrThrow(archivedRow).archivedAt, archivedAt);

      const renamed = yield* eventStore.append({
        type: "worktree.metaUpdated",
        eventId: EventId.make("evt-worktree-renamed"),
        aggregateKind: "worktree",
        aggregateId: worktreeId,
        occurredAt: "2026-05-10T00:00:00.000Z",
        commandId: CommandId.make("cmd-worktree-renamed"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-worktree-renamed"),
        metadata: {},
        payload: {
          worktreeId,
          title: "Renamed Worktree",
          branch: "feature/renamed",
          changedAt: "2026-05-10T00:00:00.000Z",
        },
      });

      yield* projectionPipeline.projectEvent(renamed);
      const renamedRow = yield* worktrees.getById({ worktreeId });
      assert.equal(Option.getOrThrow(renamedRow).title, "Renamed Worktree");
      assert.equal(Option.getOrThrow(renamedRow).branch, "feature/renamed");
    }),
  );

  it.effect("WorktreeSourceControlStateUpdated event updates projection row", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const worktrees = yield* ProjectionWorktreeRepository;
      const now = "2026-05-17T00:00:00.000Z";
      const worktreeId = WorktreeId.make("worktree-sc-state");

      const created = yield* eventStore.append({
        type: "worktree.created",
        eventId: EventId.make("evt-sc-worktree-created"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-sc-state"),
        occurredAt: now,
        commandId: CommandId.make("cmd-sc-worktree-created"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-sc-worktree-created"),
        metadata: {},
        payload: {
          worktreeId,
          projectId: ProjectId.make("project-sc-state"),
          branch: "feature/sc-state",
          worktreePath: null,
          origin: "pr",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.projectEvent(created);
      const createdRow = Option.getOrThrow(yield* worktrees.getById({ worktreeId }));
      assert.isNull(createdRow.prNumber);
      assert.isNull(createdRow.prTitle);
      assert.isNull(createdRow.prState);

      const updatedAt = "2026-05-17T01:00:00.000Z";
      const stateUpdated = yield* eventStore.append({
        type: "worktree.sourceControlStateUpdated",
        eventId: EventId.make("evt-sc-state-updated"),
        aggregateKind: "worktree",
        aggregateId: worktreeId,
        occurredAt: updatedAt,
        commandId: CommandId.make("cmd-sc-state-updated"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-sc-state-updated"),
        metadata: {},
        payload: {
          worktreeId,
          prNumber: 42,
          prTitle: "My PR",
          prState: "merged",
          prIsDraft: false,
          issueState: null,
          updatedAt,
        },
      });

      yield* projectionPipeline.projectEvent(stateUpdated);
      const updatedRow = Option.getOrThrow(yield* worktrees.getById({ worktreeId }));
      assert.equal(updatedRow.prNumber, 42);
      assert.equal(updatedRow.prTitle, "My PR");
      assert.equal(updatedRow.prState, "merged");
      assert.strictEqual(updatedRow.prIsDraft, false);
      assert.isNull(updatedRow.issueState);
    }),
  );

  it.effect("projects prTerminalAt from events and derives it for legacy events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const worktrees = yield* ProjectionWorktreeRepository;
      const now = "2026-05-19T00:00:00.000Z";
      const projectId = ProjectId.make("project-pr-terminal");
      let sequence = 0;

      const createWorktree = (worktreeId: WorktreeId) =>
        Effect.gen(function* () {
          sequence += 1;
          const created = yield* eventStore.append({
            type: "worktree.created",
            eventId: EventId.make(`evt-pr-terminal-created-${sequence}`),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId: CommandId.make(`cmd-pr-terminal-created-${sequence}`),
            causationEventId: null,
            correlationId: CommandId.make(`cmd-pr-terminal-created-${sequence}`),
            metadata: {},
            payload: {
              worktreeId,
              projectId,
              branch: `feature/${worktreeId}`,
              worktreePath: null,
              origin: "pr",
              prNumber: 7,
              issueNumber: null,
              prTitle: "PR",
              issueTitle: null,
              createdAt: now,
              updatedAt: now,
            },
          });
          yield* projectionPipeline.projectEvent(created);
        });
      const updateState = (
        worktreeId: WorktreeId,
        payload: {
          readonly prState: "open" | "merged" | "closed" | null;
          readonly prTerminalAt?: string | null;
          readonly updatedAt: string;
        },
      ) =>
        Effect.gen(function* () {
          sequence += 1;
          const event = yield* eventStore.append({
            type: "worktree.sourceControlStateUpdated",
            eventId: EventId.make(`evt-pr-terminal-updated-${sequence}`),
            aggregateKind: "worktree",
            aggregateId: worktreeId,
            occurredAt: payload.updatedAt,
            commandId: CommandId.make(`cmd-pr-terminal-updated-${sequence}`),
            causationEventId: null,
            correlationId: CommandId.make(`cmd-pr-terminal-updated-${sequence}`),
            metadata: {},
            payload: {
              worktreeId,
              prState: payload.prState,
              prIsDraft: false,
              issueState: null,
              updatedAt: payload.updatedAt,
              ...(payload.prTerminalAt !== undefined ? { prTerminalAt: payload.prTerminalAt } : {}),
            },
          });
          yield* projectionPipeline.projectEvent(event);
        });
      const prTerminalAtOf = (worktreeId: WorktreeId) =>
        worktrees
          .getById({ worktreeId })
          .pipe(Effect.map((row) => Option.getOrThrow(row).prTerminalAt));

      const explicit = WorktreeId.make("worktree-pr-terminal-explicit");
      yield* createWorktree(explicit);
      assert.isNull(yield* prTerminalAtOf(explicit));
      yield* updateState(explicit, {
        prState: "merged",
        prTerminalAt: "2026-05-19T00:30:00.000Z",
        updatedAt: "2026-05-19T01:00:00.000Z",
      });
      assert.equal(yield* prTerminalAtOf(explicit), "2026-05-19T00:30:00.000Z");

      const legacy = WorktreeId.make("worktree-pr-terminal-legacy");
      yield* createWorktree(legacy);
      yield* updateState(legacy, { prState: "open", updatedAt: "2026-05-19T01:00:00.000Z" });
      assert.isNull(yield* prTerminalAtOf(legacy));
      yield* updateState(legacy, { prState: "merged", updatedAt: "2026-05-19T02:00:00.000Z" });
      assert.equal(yield* prTerminalAtOf(legacy), "2026-05-19T02:00:00.000Z");
      yield* updateState(legacy, { prState: "merged", updatedAt: "2026-05-19T03:00:00.000Z" });
      assert.equal(yield* prTerminalAtOf(legacy), "2026-05-19T02:00:00.000Z");
    }),
  );

  it.effect("worktree.created projects Jira work item metadata", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const worktrees = yield* ProjectionWorktreeRepository;
      const now = "2026-05-18T00:00:00.000Z";
      const worktreeId = WorktreeId.make("worktree-jira-kan-4");

      const created = yield* eventStore.append({
        type: "worktree.created",
        eventId: EventId.make("evt-jira-worktree-created"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-jira"),
        occurredAt: now,
        commandId: CommandId.make("cmd-jira-worktree-created"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-jira-worktree-created"),
        metadata: {},
        payload: {
          worktreeId,
          projectId: ProjectId.make("project-jira"),
          branch: "KAN-4-super-toll",
          worktreePath: "/tmp/KAN-4-super-toll",
          origin: "issue",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          workItemProvider: "jira",
          workItemKey: "KAN-4",
          workItemTitle: "SUPER TOLL",
          workItemState: "open",
          workItemStateName: "Next to come",
          workItemUrl: "https://ryco-app.atlassian.net/browse/KAN-4",
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.projectEvent(created);
      const createdRow = Option.getOrThrow(yield* worktrees.getById({ worktreeId }));
      assert.equal(createdRow.workItemProvider, "jira");
      assert.equal(createdRow.workItemKey, "KAN-4");
      assert.equal(createdRow.workItemTitle, "SUPER TOLL");
      assert.equal(createdRow.workItemState, "open");
      assert.equal(createdRow.workItemStateName, "Next to come");
      assert.equal(createdRow.workItemUrl, "https://ryco-app.atlassian.net/browse/KAN-4");
    }),
  );

  it.effect("registers the worktree projector name", () =>
    Effect.sync(() => {
      assert.equal(ORCHESTRATION_PROJECTOR_NAMES.worktrees, "projection.worktrees");
    }),
  );
});
