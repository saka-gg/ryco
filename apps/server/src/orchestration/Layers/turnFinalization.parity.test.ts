/**
 * Three-reducer parity for turn finalization: the decider + in-memory projector,
 * the SQL projection pipeline read back through `getCommandReadModel`, and the
 * client thread store must agree on the latest turn for the same event stream.
 */
import {
  applyOrchestrationEvents,
  selectThreadsAcrossEnvironments,
  type AppState,
} from "@ryco/client-runtime/state/threads";
import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { TURN_FINALIZATION_REASON } from "../turnFinalization.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const environmentId = EnvironmentId.make("environment-parity");
const instanceId = ProviderInstanceId.make("codex");
const at = (second: number) => `2026-04-01T00:00:${String(second).padStart(2, "0")}.000Z`;

type SessionSetCommand = Extract<OrchestrationCommand, { type: "thread.session.set" }>;

interface Scenario {
  readonly name: string;
  readonly expectedState: OrchestrationLatestTurn["state"];
  readonly expectedCompletedAt: string;
  readonly steps: (ids: ScenarioIds) => ReadonlyArray<OrchestrationCommand>;
}

interface ScenarioIds {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly session: (overrides: Partial<OrchestrationSession>) => OrchestrationSession;
  readonly sessionSet: (
    id: string,
    session: OrchestrationSession,
    turnOutcome?: SessionSetCommand["turnOutcome"],
  ) => SessionSetCommand;
  readonly diff: (id: string, status: "ready" | "missing", second: number) => OrchestrationCommand;
}

const makeIds = (key: string): ScenarioIds => {
  const threadId = ThreadId.make(`thread-parity-${key}`);
  const turnId = TurnId.make(`turn-parity-${key}`);
  const session = (overrides: Partial<OrchestrationSession>): OrchestrationSession => ({
    threadId,
    status: "ready",
    providerName: "codex",
    providerInstanceId: instanceId,
    runtimeSessionId: RuntimeSessionId.make(`runtime-${key}`),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: at(0),
    ...overrides,
  });
  return {
    projectId: ProjectId.make(`project-parity-${key}`),
    threadId,
    turnId,
    session,
    sessionSet: (id, next, turnOutcome) => ({
      type: "thread.session.set",
      commandId: CommandId.make(`${key}-${id}`),
      threadId,
      session: next,
      ...(turnOutcome ? { turnOutcome } : {}),
      createdAt: next.updatedAt,
    }),
    diff: (id, status, second) => ({
      type: "thread.turn.diff.complete",
      commandId: CommandId.make(`${key}-${id}`),
      threadId,
      turnId,
      completedAt: at(second),
      checkpointRef: CheckpointRef.make(`refs/ryco/checkpoints/${key}/1`),
      status,
      files: [],
      checkpointTurnCount: 1,
      createdAt: at(second),
    }),
  };
};

/** Project, thread, a user turn and the provider's turn.started projection. */
const startTurn = (ids: ScenarioIds, key: string): ReadonlyArray<OrchestrationCommand> => [
  {
    type: "project.create",
    commandId: CommandId.make(`${key}-project`),
    projectId: ids.projectId,
    title: "Parity",
    workspaceRoot: `/tmp/parity-${key}`,
    defaultModelSelection: { instanceId, model: "gpt-5-codex" },
    createdAt: at(0),
  },
  {
    type: "thread.create",
    commandId: CommandId.make(`${key}-thread`),
    threadId: ids.threadId,
    projectId: ids.projectId,
    title: "Parity",
    modelSelection: { instanceId, model: "gpt-5-codex" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: at(0),
  },
  {
    type: "thread.turn.start",
    commandId: CommandId.make(`${key}-turn-start`),
    threadId: ids.threadId,
    message: {
      messageId: MessageId.make(`${key}-user`),
      role: "user",
      text: "Do the work",
      attachments: [],
    },
    modelSelection: { instanceId, model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: at(1),
  },
  ids.sessionSet(
    "running",
    ids.session({ status: "running", activeTurnId: ids.turnId, updatedAt: at(2) }),
  ),
];

const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "non-git turn without assistant text completes",
    expectedState: "completed",
    expectedCompletedAt: at(10),
    steps: (ids) => [
      ...startTurn(ids, "a"),
      ids.sessionSet("ready", ids.session({ updatedAt: at(10) }), {
        turnId: ids.turnId,
        state: "completed",
        reason: TURN_FINALIZATION_REASON.providerTurnCompleted,
        completedAt: at(10),
      }),
    ],
  },
  {
    name: "failure after a final assistant message",
    expectedState: "error",
    expectedCompletedAt: at(10),
    steps: (ids) => [
      ...startTurn(ids, "b"),
      {
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("b-assistant"),
        threadId: ids.threadId,
        messageId: MessageId.make("b-assistant"),
        turnId: ids.turnId,
        text: "Here is what I found",
        createdAt: at(5),
      },
      ids.sessionSet(
        "error",
        ids.session({ status: "error", lastError: "provider failed", updatedAt: at(10) }),
        {
          turnId: ids.turnId,
          state: "error",
          reason: TURN_FINALIZATION_REASON.providerTurnCompleted,
          completedAt: at(10),
        },
      ),
    ],
  },
  {
    name: "Stop in git: interrupt, release, late missing diff",
    expectedState: "interrupted",
    expectedCompletedAt: at(5),
    steps: (ids) => [
      ...startTurn(ids, "c"),
      {
        type: "thread.turn.interrupt",
        commandId: CommandId.make("c-stop"),
        threadId: ids.threadId,
        turnId: ids.turnId,
        createdAt: at(5),
      },
      ids.sessionSet("ready", ids.session({ updatedAt: at(10) }), {
        turnId: ids.turnId,
        state: "completed",
        reason: TURN_FINALIZATION_REASON.providerTurnCompleted,
        completedAt: at(10),
      }),
      ids.diff("late-diff", "missing", 20),
    ],
  },
  {
    name: "placeholder diff mid-turn, then completed",
    expectedState: "completed",
    expectedCompletedAt: at(10),
    steps: (ids) => [
      ...startTurn(ids, "d"),
      ids.diff("placeholder", "missing", 4),
      ids.sessionSet("ready", ids.session({ updatedAt: at(10) }), {
        turnId: ids.turnId,
        state: "completed",
        reason: TURN_FINALIZATION_REASON.providerTurnCompleted,
        completedAt: at(10),
      }),
      ids.diff("capture", "ready", 12),
    ],
  },
  {
    name: "session replaced mid-turn",
    expectedState: "interrupted",
    expectedCompletedAt: at(10),
    steps: (ids) => [
      ...startTurn(ids, "e"),
      ids.sessionSet(
        "rebind",
        ids.session({ runtimeSessionId: RuntimeSessionId.make("runtime-e-2"), updatedAt: at(10) }),
        {
          state: "interrupted",
          reason: TURN_FINALIZATION_REASON.sessionReplaced,
          completedAt: at(10),
        },
      ),
    ],
  },
];

/** Run commands through the decider and in-memory projector, collecting the events. */
const decideAll = (commands: ReadonlyArray<OrchestrationCommand>) =>
  Effect.gen(function* () {
    let readModel: OrchestrationReadModel = createEmptyReadModel(at(0));
    const events: OrchestrationEvent[] = [];
    for (const command of commands) {
      const decided = yield* decideOrchestrationCommand({ command, readModel });
      for (const planned of Array.isArray(decided) ? decided : [decided]) {
        const event = {
          ...planned,
          sequence: readModel.snapshotSequence + 1,
        } as OrchestrationEvent;
        events.push(event);
        readModel = yield* projectEvent(readModel, event);
      }
    }
    return { readModel, events };
  });

const turnSummary = (turn: OrchestrationLatestTurn | null | undefined) =>
  turn ? { turnId: turn.turnId, state: turn.state, completedAt: turn.completedAt } : null;

const ParityLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(RepositoryIdentityResolverLive),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-turn-parity-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    Layer.succeed(ProjectAvatarStore, {
      write: () => Effect.die("ProjectAvatarStore.write not implemented in test"),
      read: () => Effect.succeed(null),
      remove: () => Effect.void,
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(Layer.fresh(ParityLayer))("turn finalization parity", (it) => {
  for (const [index, scenario] of scenarios.entries()) {
    it.effect(`agrees across the three reducers: ${scenario.name}`, () =>
      Effect.gen(function* () {
        const ids = makeIds(String.fromCharCode(97 + index));
        const { readModel, events } = yield* decideAll(scenario.steps(ids));
        const expected = {
          turnId: ids.turnId,
          state: scenario.expectedState,
          completedAt: scenario.expectedCompletedAt,
        };

        // 1. Decider's in-memory model.
        const inMemory = readModel.threads.find((thread) => thread.id === ids.threadId);
        assert.deepStrictEqual(turnSummary(inMemory?.latestTurn), expected, "in-memory");

        // 2. SQL projection, read back the way a restart reloads the decider.
        const pipeline = yield* OrchestrationProjectionPipeline;
        for (const event of events) {
          yield* pipeline.projectEvent(event);
        }
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const commandReadModel = yield* snapshotQuery.getCommandReadModel();
        const persisted = commandReadModel.threads.find((thread) => thread.id === ids.threadId);
        assert.deepStrictEqual(turnSummary(persisted?.latestTurn), expected, "sql");

        // 3. Client thread store fed the same event stream.
        const initial: AppState = { activeEnvironmentId: environmentId, environmentStateById: {} };
        const clientState = applyOrchestrationEvents(initial, events, environmentId);
        const clientThread = selectThreadsAcrossEnvironments(clientState).find(
          (thread) => thread.id === ids.threadId,
        );
        assert.deepStrictEqual(turnSummary(clientThread?.latestTurn), expected, "client");
      }),
    );
  }
});
