import { Cause, Effect, Option, Schema } from "effect";
import {
  LOCAL_TASK_MAX_FILE_TOTAL_BYTES,
  LOCAL_TASK_MAX_FILES,
  type LocalTaskDelegateInput,
  LocalTaskError,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  WS_METHODS,
} from "@ryco/contracts";
import {
  normalizeDispatchCommand,
  withChatAttachmentAdoption,
} from "../orchestration/Normalizer.ts";
import {
  applyOrchestrationNormalizedCommand,
  orchestrationCommandFlights,
} from "../orchestration/Layers/OrchestrationCommandApplication.ts";
import type { LocalTaskServiceShape } from "../tasks/LocalTaskService.ts";
import {
  copyTaskFilesToThread,
  deleteTaskFileCopies,
  deleteTaskFiles,
  toLocalTaskFile,
  writeTaskFileFromDataUrl,
} from "../tasks/taskFiles.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

const invalid = (message: string) => new LocalTaskError({ reason: "invalid", message });

/**
 * A delegation runs in the process-wide command flights, keyed by its command id like a plain
 * dispatch, so its flight carries the dispatch error; a task error travels as that error's cause
 * and is restored after the flight.
 */
const toFlightError = (cause: LocalTaskError | OrchestrationDispatchCommandError) =>
  Schema.is(LocalTaskError)(cause)
    ? new OrchestrationDispatchCommandError({ message: cause.message, cause })
    : cause;
const fromFlightError = (cause: OrchestrationDispatchCommandError) =>
  Schema.is(LocalTaskError)(cause.cause) ? cause.cause : cause;

/** What a start's failure tells the user; the reason of a typed error, or a generic one. */
const startFailureMessage = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) {
    const value: unknown = failure.value;
    if (typeof value === "object" && value !== null && "message" in value) {
      const message = String(value.message).trim();
      if (message.length > 0) return message;
    }
  }
  return "The chat could not be started.";
};

const isTurnStart = (
  command: OrchestrationCommand,
): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
  command.type === "thread.turn.start";

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
  const uploads = Option.match(ctx.chatAttachmentUploads, {
    onNone: () => Effect.fail(invalid("Task file uploads are not available on this node.")),
    onSome: Effect.succeed,
  });

  /**
   * One attempt of a chat start: normalize the command (a validation failure must not leave a
   * reservation), reserve the start, add the task's files to the message, dispatch it through
   * normal orchestration (a bootstrap start creates its thread and worktree there), then mark it.
   * A failure after the reservation marks the start failed and deletes the file copies this
   * attempt made, which no message references then (a failed bootstrap may never create the
   * thread whose deletion would sweep them). An interruption does neither: the engine may still
   * commit an interrupted command, and the restart sweep settles it.
   */
  const delegateAttempt = (tasks: LocalTaskServiceShape, input: LocalTaskDelegateInput) =>
    withChatAttachmentAdoption(
      input.command,
      Effect.gen(function* () {
        const normalized = yield* normalizeDispatchCommand(input.command);
        if (!isTurnStart(normalized))
          return yield* invalid("A task's chat starts with a turn start command.");
        const reservation = yield* tasks.reserveDelegation(input);
        if (!reservation.needsDispatch) return { sequence: 0 };
        const commandId = reservation.command.commandId;
        let createdCopies: ReadonlyArray<string> = [];
        const result = yield* Effect.gen(function* () {
          const copies = yield* copyTaskFilesToThread({
            taskFilesDir: ctx.config.taskFilesDir,
            attachmentsDir: ctx.config.attachmentsDir,
            threadId: normalized.threadId,
            files: reservation.files,
          });
          createdCopies = copies.createdIds;
          return yield* applyOrchestrationNormalizedCommand({
            command:
              copies.attachments.length === 0
                ? normalized
                : {
                    ...normalized,
                    message: {
                      ...normalized.message,
                      attachments: [...normalized.message.attachments, ...copies.attachments],
                    },
                  },
            dispatch: ctx.dispatchNormalizedCommand,
            projections: ctx.projectionSnapshotQuery,
            terminals: ctx.terminalManager,
          });
        }).pipe(
          Effect.onError((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.void
              : tasks.markDelegationFailed(commandId, startFailureMessage(cause)).pipe(
                  Effect.flatMap((failed) =>
                    failed
                      ? deleteTaskFileCopies({
                          attachmentsDir: ctx.config.attachmentsDir,
                          threadId: normalized.threadId,
                          attachmentIds: createdCopies,
                        })
                      : Effect.void,
                  ),
                  Effect.ignore,
                ),
          ),
        );
        // Outside the failure handling: a start that did dispatch never reads as failed. If
        // this write fails, the restart sweep finds the accepted receipt.
        yield* tasks.markDelegated(commandId);
        return result;
      }),
    ).pipe(Effect.mapError(toFlightError));

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
          // A settled start is answered before touching possibly expired upload references.
          const settled = yield* tasks.getSettledDelegation(input);
          if (settled) return settled;
          // Joining the running attempt makes a concurrent or retried identical call dispatch
          // once, and the detached attempt survives a client that disconnects mid-bootstrap.
          // Nothing reads the flight's sequence: the answer is the task.
          yield* orchestrationCommandFlights
            .join(input.command.commandId, delegateAttempt(tasks, input))
            .pipe(Effect.mapError(fromFlightError));
          return yield* tasks.get(input.taskId);
        }),
      ),
    [WS_METHODS.serverCreateLocalTaskFileUpload]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.serverCreateLocalTaskFileUpload,
        Effect.gen(function* () {
          const tasks = yield* service;
          const task = yield* tasks.get(input.taskId);
          // Refuse an upload the task could never add, before its bytes travel.
          if (
            task.files.length >= LOCAL_TASK_MAX_FILES ||
            task.files.reduce((total, file) => total + file.sizeBytes, input.sizeBytes) >
              LOCAL_TASK_MAX_FILE_TOTAL_BYTES
          )
            return yield* invalid(
              `A task holds at most ${LOCAL_TASK_MAX_FILES} files of ${LOCAL_TASK_MAX_FILE_TOTAL_BYTES} bytes in total.`,
            );
          const registry = yield* uploads;
          return yield* registry
            .createForTask(input)
            .pipe(Effect.mapError((cause) => invalid(cause.message)));
        }),
      ),
    [WS_METHODS.serverAddLocalTaskFile]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.serverAddLocalTaskFile,
        Effect.gen(function* () {
          const tasks = yield* service;
          const addedAt = new Date().toISOString();
          const uploadToken = input.uploadToken;
          if (uploadToken !== undefined) {
            const registry = yield* uploads;
            const claimed = yield* registry
              .claimForTask({
                uploadToken,
                taskId: input.taskId,
                name: input.name,
                mimeType: input.mimeType,
                sizeBytes: input.sizeBytes,
              })
              .pipe(Effect.mapError((cause) => invalid(cause.message)));
            return yield* tasks
              .addFile({
                taskId: input.taskId,
                expectedRevision: input.expectedRevision,
                file: toLocalTaskFile({
                  fileId: claimed.attachmentId,
                  name: input.name,
                  mimeType: input.mimeType,
                  sizeBytes: input.sizeBytes,
                  width: claimed.width ?? input.width,
                  height: claimed.height ?? input.height,
                  addedAt,
                }),
              })
              .pipe(
                // A refused add hands the upload back: the same token claims it again for a
                // retry, and once it expires unclaimed its file is deleted. Only a failure: an
                // add is one transaction, so a failed one references nothing, while an
                // interrupted one may have committed.
                Effect.tapError(() =>
                  registry.releaseTaskClaim({ uploadToken, taskId: input.taskId }),
                ),
              );
          }
          if (input.dataUrl === undefined)
            return yield* invalid("Provide exactly one of dataUrl or uploadToken.");
          const written = yield* writeTaskFileFromDataUrl({
            taskFilesDir: ctx.config.taskFilesDir,
            taskId: input.taskId,
            name: input.name,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            dataUrl: input.dataUrl,
          });
          return yield* tasks
            .addFile({
              taskId: input.taskId,
              expectedRevision: input.expectedRevision,
              file: toLocalTaskFile({
                fileId: written.fileId,
                name: input.name,
                mimeType: input.mimeType,
                sizeBytes: input.sizeBytes,
                width: written.width ?? input.width,
                height: written.height ?? input.height,
                addedAt,
              }),
            })
            .pipe(
              // A retry writes a new file, so this one belongs to nothing.
              Effect.onError(() => deleteTaskFiles(ctx.config.taskFilesDir, [written.fileId])),
            );
        }),
      ),
    [WS_METHODS.serverRemoveLocalTaskFile]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.serverRemoveLocalTaskFile,
        service.pipe(Effect.flatMap((tasks) => tasks.removeFile(input))),
      ),
  });
}
