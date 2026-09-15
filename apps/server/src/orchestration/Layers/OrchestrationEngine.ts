import { ProjectionThreadUserInputRequestRepository } from "../../persistence/Services/ProjectionThreadUserInputRequests.ts";
import { ProjectionThreadUserInputRequestRepositoryLive } from "../../persistence/Layers/ProjectionThreadUserInputRequests.ts";
import { ApprovalRequestId } from "@ryco/contracts";
import {
  requireApprovalClaim,
  requireApprovalSource,
  requireUserInputClaim,
  questionAsCallback,
} from "../approvalResponses.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import { OrchestrationCommand } from "@ryco/contracts";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  PubSub,
  Queue,
  Schema,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { makeServerQueueMetrics } from "../../observability/QueueMetrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread" | "worktree";
  readonly aggregateId: ProjectId | ThreadId | WorktreeId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.avatar.set":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    case "worktree.create":
    case "worktree.archive":
    case "worktree.meta.update":
    case "worktree.source-control-state.update":
    case "worktree.restore":
    case "worktree.delete":
    case "worktree.manual-position.set":
      return {
        aggregateKind: "worktree",
        aggregateId: command.worktreeId,
      };
    case "thread.create":
    case "thread.delete":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.snooze":
    case "thread.unsnooze":
    case "thread.settle":
    case "thread.unsettle":
    case "thread.meta.update":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.token-mode.set":
    case "thread.goal.set":
    case "thread.goal.clear":
    case "thread.goal.sync":
    case "thread.goal.provider-clear":
    case "thread.turn.start":
    case "thread.turn.steer":
    case "thread.turn.steer.resolve":
    case "thread.turn.interrupt":
    case "thread.approval.respond":
    case "thread.user-input.respond":
    case "thread.checkpoint.revert":
    case "thread.session.stop":
    case "thread.attach-to-worktree":
    case "thread.status-bucket.override":
    case "thread.manual-position.set":
    case "thread.session.set":
    case "thread.message.assistant.delta":
    case "thread.message.assistant.complete":
    case "thread.history.restore":
    case "thread.proposed-plan.upsert":
    case "thread.turn.diff.complete":
    case "thread.activity.append":
    case "thread.revert.complete":
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const approvals = yield* ProjectionPendingApprovalRepository;
  const questions = yield* ProjectionThreadUserInputRequestRepository;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  let commandReadModel = createEmptyReadModel(new Date().toISOString());

  const commandQueue = yield* Queue.bounded<CommandEnvelope>(1_024);
  const commandQueueMetrics = yield* makeServerQueueMetrics({
    queue: "orchestration.command",
    component: "OrchestrationEngine",
  });
  const eventPubSub = yield* PubSub.bounded<OrchestrationEvent>(4_096);

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    const processingStartedAtMs = Date.now();
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        if (
          envelope.command.type === "thread.activity.append" &&
          [
            "approval.requested",
            "approval.resolved",
            "provider.approval.respond.failed",
            "user-input.requested",
            "user-input.resolved",
            "provider.user-input.respond.failed",
          ].includes(envelope.command.activity.kind)
        ) {
          const command = envelope.command;
          const payload = command.activity.payload as Record<string, unknown> | null;
          const isQuestion = command.activity.kind.includes("user-input");
          const row =
            typeof payload?.requestId === "string"
              ? isQuestion
                ? yield* questions
                    .getByRequestId({
                      threadId: command.threadId,
                      requestId: ApprovalRequestId.make(payload.requestId),
                    })
                    .pipe(Effect.map(Option.map(questionAsCallback)))
                : yield* approvals.getByRequestId({
                    threadId: command.threadId,
                    requestId: ApprovalRequestId.make(payload.requestId),
                  })
              : Option.none();
          const seen = command.activity.kind.endsWith(".requested")
            ? yield* sql`SELECT activity_id FROM projection_thread_activities WHERE activity_id = ${command.activity.id} AND thread_id = ${command.threadId} LIMIT 1`.pipe(
                Effect.mapError(toPersistenceSqlError("approval.request.identity")),
              )
            : [];
          yield* requireApprovalSource(
            {
              command,
              row,
              seenRequest: seen.length > 0,
              session: commandReadModel.threads.find((thread) => thread.id === command.threadId)
                ?.session,
            },
            isQuestion ? "user-input" : "approval",
          );
        }
        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: commandReadModel,
        });
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (envelope.command.type === "thread.approval.respond") {
                const command = envelope.command;
                yield* requireApprovalClaim({
                  command,
                  row: yield* approvals.getByRequestId({
                    threadId: command.threadId,
                    requestId: command.requestId,
                  }),
                  session: commandReadModel.threads.find((thread) => thread.id === command.threadId)
                    ?.session,
                });
              }
              if (envelope.command.type === "thread.user-input.respond") {
                const command = envelope.command;
                yield* requireUserInputClaim({
                  command,
                  row: yield* questions.getByRequestId({
                    threadId: command.threadId,
                    requestId: command.requestId,
                  }),
                  session: commandReadModel.threads.find((thread) => thread.id === command.threadId)
                    ?.session,
                });
              }
              const committedEvents: OrchestrationEvent[] = [];
              const postCommitEffects: Array<Effect.Effect<void>> = [];
              let nextCommandReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                postCommitEffects.push(
                  yield* projectionPipeline.projectEventInTransaction(savedEvent),
                );
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
                postCommitEffects,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        commandReadModel = committedCommand.nextCommandReadModel;
        yield* Effect.forEach(committedCommand.postCommitEffects, (effect) => effect, {
          concurrency: 1,
          discard: true,
        });
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, Date.now() - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, Date.now() - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (!Schema.is(OrchestrationCommandPreviouslyRejectedError)(error)) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (Schema.is(OrchestrationCommandInvariantError)(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: new Date().toISOString(),
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(
    Queue.take(commandQueue).pipe(
      Effect.tap(() => commandQueueMetrics.recordDequeued()),
      Effect.flatMap(processEnvelope),
    ),
  );
  yield* Effect.forkScoped(worker);
  yield* Effect.addFinalizer(() => commandQueueMetrics.reset);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const readEventsPage: OrchestrationEngineShape["readEventsPage"] = (
    fromSequenceExclusive,
    limit,
  ) => eventStore.readPage(fromSequenceExclusive, limit);

  const readRecentEvents: OrchestrationEngineShape["readRecentEvents"] = (input) =>
    eventStore.readRecent === undefined ? Effect.succeed([]) : eventStore.readRecent(input);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      const admissionStartedAtMs = Date.now();
      yield* Queue.offer(commandQueue, { command, result, startedAtMs: Date.now() });
      yield* commandQueueMetrics.recordBlocked(Date.now() - admissionStartedAtMs);
      yield* commandQueueMetrics.recordEnqueued();
      return yield* Deferred.await(result);
    });

  return {
    readEvents,
    readEventsPage,
    readRecentEvents,
    dispatch,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    get subscribeDomainEvents(): OrchestrationEngineShape["subscribeDomainEvents"] {
      return PubSub.subscribe(eventPubSub);
    },
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
).pipe(
  Layer.provide(ProjectionPendingApprovalRepositoryLive),
  Layer.provide(ProjectionThreadUserInputRequestRepositoryLive),
);
