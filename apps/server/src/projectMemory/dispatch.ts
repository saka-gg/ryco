import { ProviderSessionNotFoundError } from "../provider/Errors.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import {
  CommandId,
  EventId,
  ProjectMemoryError,
  type ProjectMemoryRecallInput,
  type ThreadId,
} from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";
import { type ProjectMemoryServiceShape } from "./ProjectMemoryService.ts";
import {
  takeMemoryDispatchAuthorization,
  forgetMemoryDispatchAuthorization,
} from "./dispatchAuthorization.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

/** Both ordinary and handoff sends use this final boundary; never store the rendered envelope. */
export const submitWithProjectMemory = <A, E, R>(options: {
  readonly memory: Option.Option<ProjectMemoryServiceShape>;
  readonly engine: OrchestrationEngineShape;
  readonly providers: ProviderServiceShape;
  readonly recall?: ProjectMemoryRecallInput;
  readonly threadId: ThreadId;
  readonly commandId: string;
  readonly messageId: string;
  readonly submit: (
    envelope: string,
    expectedRuntime?: Parameters<ProviderServiceShape["sendTurn"]>[1],
  ) => Effect.Effect<A, E, R>;
}) =>
  Effect.gen(function* () {
    if (!options.recall) return yield* options.submit("");
    const service = options.memory;
    if (Option.isNone(service))
      return yield* Effect.fail(
        new ProjectMemoryError({
          reason: "unavailable",
          message: "Project memory is unavailable.",
        }),
      );
    const engine = options.engine;
    const session = yield* options.providers.getSession(options.threadId);
    if (
      Option.isNone(session) ||
      !session.value.providerInstanceId ||
      !session.value.runtimeSessionId
    )
      return yield* Effect.fail(
        new ProjectMemoryError({
          reason: "unavailable",
          message: "Memory recall requires a current provider runtime.",
        }),
      );
    const runtime = {
      threadId: options.threadId,
      provider: session.value.provider,
      providerInstanceId: session.value.providerInstanceId,
      runtimeSessionId: session.value.runtimeSessionId,
    };
    const mark = (status: "submitted" | "failed-or-uncertain") => {
      const createdAt = new Date().toISOString();
      return engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`memory:${status}:${options.commandId}`),
          threadId: options.threadId,
          activity: {
            id: EventId.make(`memory:${status}:${options.commandId}`),
            kind: "project.memory.recall",
            tone: status === "submitted" ? "info" : "error",
            summary:
              status === "submitted"
                ? "Selected project memory submitted"
                : "Project memory delivery failed or is uncertain",
            payload: {
              status,
              messageId: options.messageId,
              projectId: options.recall!.projectId,
              references: options.recall!.references,
            },
            turnId: null,
            createdAt,
          },
          createdAt,
        })
        .pipe(Effect.asVoid);
    };
    return yield* service.value
      .submitRecall(
        { ...options.recall, threadId: options.threadId, runtime },
        takeMemoryDispatchAuthorization(
          options.commandId,
          options.threadId,
          options.recall.projectId,
        ).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const current = yield* options.providers.getSession(options.threadId).pipe(
                Effect.mapError(
                  () =>
                    new ProjectMemoryError({
                      reason: "unavailable",
                      message: "Could not verify current memory runtime.",
                    }),
                ),
              );
              if (
                Option.isNone(current) ||
                current.value.runtimeSessionId !== runtime.runtimeSessionId ||
                current.value.providerInstanceId !== runtime.providerInstanceId
              )
                return yield* Effect.fail(
                  new ProjectMemoryError({
                    reason: "conflict",
                    message: "Provider runtime changed. Review the memory selection again.",
                  }),
                );
            }),
          ),
        ),
        (envelope) =>
          options.submit(envelope, {
            ...runtime,
            beforeSubmit: takeMemoryDispatchAuthorization(
              options.commandId,
              options.threadId,
              options.recall!.projectId,
            ).pipe(
              Effect.mapError(
                () => new ProviderSessionNotFoundError({ threadId: options.threadId }),
              ),
            ),
          }),
      )
      .pipe(
        Effect.mapError((error) =>
          Schema.is(ProjectMemoryError)(error)
            ? error
            : new ProjectMemoryError({
                reason: "unavailable",
                message:
                  "Memory submission failed or delivery is uncertain. Review the turn before retrying.",
              }),
        ),
        Effect.tap(() => mark("submitted")),
        Effect.onError(() => mark("failed-or-uncertain").pipe(Effect.ignore)),
        Effect.ensuring(Effect.sync(() => forgetMemoryDispatchAuthorization(options.commandId))),
      );
  });
