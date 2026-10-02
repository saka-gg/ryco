import { Effect, Option } from "effect";
import { LocalTaskError, WS_METHODS } from "@ryco/contracts";
import {
  normalizeDispatchCommand,
  withChatAttachmentAdoption,
} from "../orchestration/Normalizer.ts";
import { applyOrchestrationNormalizedCommand } from "../orchestration/Layers/OrchestrationCommandApplication.ts";
import type { LocalTaskServiceShape } from "../tasks/LocalTaskService.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

export function makeLocalTaskHandlers(ctx: WsRpcContext) {
  const service: Effect.Effect<LocalTaskServiceShape, LocalTaskError> = Option.match(
    ctx.localTaskService,
    {
      onNone: () =>
        Effect.fail(
          new LocalTaskError({
            reason: "persistence",
            message: "Local tasks are unavailable on this node.",
          }),
        ),
      onSome: Effect.succeed,
    },
  );
  return defineWsHandlers({
    [WS_METHODS.serverListLocalTasks]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.serverListLocalTasks,
        service.pipe(Effect.flatMap((tasks) => tasks.list(input))),
      ),
    [WS_METHODS.serverGetLocalTask]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.serverGetLocalTask,
        service.pipe(Effect.flatMap((tasks) => tasks.get(input.taskId))),
      ),
    [WS_METHODS.serverCreateLocalTask]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.serverCreateLocalTask,
        service.pipe(Effect.flatMap((tasks) => tasks.create(input))),
      ),
    [WS_METHODS.serverUpdateLocalTask]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.serverUpdateLocalTask,
        service.pipe(Effect.flatMap((tasks) => tasks.update(input))),
      ),
    [WS_METHODS.serverDeleteLocalTask]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.serverDeleteLocalTask,
        service.pipe(Effect.flatMap((tasks) => tasks.remove(input))),
      ),
    [WS_METHODS.serverDelegateLocalTask]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.serverDelegateLocalTask,
        Effect.gen(function* () {
          const tasks = yield* service;
          // Receipts are checked before touching possibly expired upload references.
          const accepted = yield* tasks.getAcceptedDelegation(input);
          if (accepted) return accepted;
          return yield* withChatAttachmentAdoption(
            input.command,
            Effect.gen(function* () {
              // A validation failure must not leave an immutable delegation reservation.
              const normalized = yield* normalizeDispatchCommand(input.command);
              const reservation = yield* tasks.reserveDelegation(input);
              if (reservation.task.delegation?.dispatched) return reservation.task;
              yield* applyOrchestrationNormalizedCommand({
                command: normalized,
                dispatch: ctx.dispatchNormalizedCommand,
                projections: ctx.projectionSnapshotQuery,
                terminals: ctx.terminalManager,
              });
              return yield* tasks.markDelegated({
                taskId: input.taskId,
                commandId: reservation.command.commandId,
              });
            }),
          );
        }),
      ),
  });
}
