import {
  CommandId,
  OrchestrationDispatchCommandError,
  type OrchestrationCommand,
} from "@ryco/contracts";
import { Deferred, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceipt,
  type OrchestrationCommandReceiptRepositoryShape,
} from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import type { TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import { WorkspaceAccessPolicy } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import { OrchestrationCommandPreviouslyRejectedError } from "../Errors.ts";
import { normalizeDispatchCommand, withChatAttachmentAdoption } from "../Normalizer.ts";
import {
  OrchestrationCommandApplication,
  type OrchestrationCommandApplicationShape,
  type OrchestrationNormalizedCommandDispatcher,
} from "../Services/OrchestrationCommandApplication.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import type { ProjectionSnapshotQueryShape } from "../Services/ProjectionSnapshotQuery.ts";

const toDispatchError = (cause: unknown) =>
  Schema.is(OrchestrationDispatchCommandError)(cause)
    ? cause
    : new OrchestrationDispatchCommandError({
        message: "Failed to dispatch orchestration command",
        cause,
      });

export const applyOrchestrationNormalizedCommand = <R = never>(deps: {
  readonly command: OrchestrationCommand;
  readonly dispatch: OrchestrationNormalizedCommandDispatcher;
  readonly projections: ProjectionSnapshotQueryShape;
  readonly terminals: TerminalManagerShape;
  readonly normalizeFollowup?: (
    command: Parameters<OrchestrationCommandApplicationShape["apply"]>[0],
  ) => Effect.Effect<OrchestrationCommand, OrchestrationDispatchCommandError, R>;
}) => {
  const { command, dispatch, projections, terminals } = deps;
  return Effect.gen(function* () {
    const shouldStopSessionAfterArchive =
      command.type === "thread.archive"
        ? yield* projections.getThreadShellById(command.threadId).pipe(
            Effect.map(
              Option.match({
                onNone: () => false,
                onSome: (thread) => thread.session !== null && thread.session.status !== "stopped",
              }),
            ),
            Effect.catch(() => Effect.succeed(false)),
          )
        : false;

    const result = yield* dispatch(command);
    if (command.type !== "thread.archive") return result;

    if (shouldStopSessionAfterArchive) {
      const stopCommand = {
        type: "thread.session.stop",
        commandId: CommandId.make(`session-stop-for-archive:${command.commandId}`),
        threadId: command.threadId,
        createdAt: new Date().toISOString(),
      } as const;
      const normalizedStopCommand = deps.normalizeFollowup
        ? yield* deps.normalizeFollowup(stopCommand)
        : stopCommand;
      yield* dispatch(normalizedStopCommand).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to stop provider session during archive", {
            threadId: command.threadId,
            cause,
          }),
        ),
      );
    }

    yield* terminals.close({ threadId: command.threadId }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to close thread terminals after archive", {
          threadId: command.threadId,
          error: error.message,
        }),
      ),
    );
    return result;
  }).pipe(Effect.mapError(toDispatchError));
};

/**
 * The outcome a command already has, if its id was seen before. A client that
 * lost the response to a relay drop re-sends the identical command; its first
 * attempt may have committed, and normalization can no longer succeed for it
 * (its streamed uploads were adopted, or the node restarted and forgot their
 * reservations). Answering from the receipt first keeps that replay
 * idempotent. A receipt that cannot be read falls through: the engine checks it
 * again before executing anything.
 */
const priorCommandOutcome = (
  receipts: Pick<OrchestrationCommandReceiptRepositoryShape, "getByCommandId">,
  command: Parameters<OrchestrationCommandApplicationShape["apply"]>[0],
): Effect.Effect<Option.Option<{ readonly sequence: number }>, OrchestrationDispatchCommandError> =>
  Effect.gen(function* () {
    const receipt = yield* receipts
      .getByCommandId({ commandId: command.commandId })
      .pipe(Effect.catch(() => Effect.succeed(Option.none<OrchestrationCommandReceipt>())));
    if (Option.isNone(receipt)) return Option.none();
    if (receipt.value.status === "accepted") {
      return Option.some({ sequence: receipt.value.resultSequence });
    }
    // The same rejection the engine reports for a repeated id.
    const rejection = new OrchestrationCommandPreviouslyRejectedError({
      commandId: command.commandId,
      detail: receipt.value.error ?? "Previously rejected.",
    });
    return yield* new OrchestrationDispatchCommandError({
      message: rejection.message,
      cause: rejection,
    });
  });

type CommandResult = { readonly sequence: number };

/**
 * The client commands this node is executing right now, by `commandId`.
 *
 * A hosted client replays a command whose response a relay drop lost, and the
 * replay can arrive while the first attempt still runs: a bootstrap turn start
 * creates its thread and worktree long before the receipt for its final turn
 * start exists. Joining the running attempt answers the replay with that
 * attempt's own outcome, where running the command again would collide with
 * what the first attempt already created and report a failure for a send that
 * is about to succeed. The attempt runs detached from the request that started
 * it, so a client that disconnects mid-command cannot cut it off halfway — a
 * replay then finds either the running attempt or its receipt.
 */
export interface OrchestrationCommandFlights {
  readonly join: <R>(
    commandId: CommandId,
    attempt: Effect.Effect<CommandResult, OrchestrationDispatchCommandError, R>,
  ) => Effect.Effect<CommandResult, OrchestrationDispatchCommandError, R>;
}

export const makeOrchestrationCommandFlights = (): OrchestrationCommandFlights => {
  const running = new Map<
    CommandId,
    Deferred.Deferred<CommandResult, OrchestrationDispatchCommandError>
  >();
  return {
    join: (commandId, attempt) =>
      Effect.suspend(() => {
        const existing = running.get(commandId);
        if (existing) return Deferred.await(existing);
        const outcome = Deferred.makeUnsafe<CommandResult, OrchestrationDispatchCommandError>();
        running.set(commandId, outcome);
        return attempt.pipe(
          Effect.onExit((exit) =>
            Effect.suspend(() => {
              if (running.get(commandId) === outcome) running.delete(commandId);
              return Deferred.done(outcome, exit);
            }),
          ),
          Effect.forkDetach,
          Effect.andThen(Deferred.await(outcome)),
        );
      }),
  };
};

/** Process-wide: a replay arrives over a different connection than its first attempt. */
export const orchestrationCommandFlights = makeOrchestrationCommandFlights();

export const applyOrchestrationCommand = <R>(deps: {
  readonly command: Parameters<OrchestrationCommandApplicationShape["apply"]>[0];
  readonly normalize: (
    command: Parameters<OrchestrationCommandApplicationShape["apply"]>[0],
  ) => Effect.Effect<OrchestrationCommand, OrchestrationDispatchCommandError, R>;
  readonly dispatch: OrchestrationNormalizedCommandDispatcher;
  readonly projections: ProjectionSnapshotQueryShape;
  readonly terminals: TerminalManagerShape;
  readonly receipts?: Pick<OrchestrationCommandReceiptRepositoryShape, "getByCommandId">;
  readonly flights?: OrchestrationCommandFlights;
}): Effect.Effect<CommandResult, OrchestrationDispatchCommandError, R> => {
  const apply = withChatAttachmentAdoption(
    deps.command,
    deps.normalize(deps.command).pipe(
      Effect.flatMap((command) =>
        applyOrchestrationNormalizedCommand({
          command,
          dispatch: deps.dispatch,
          projections: deps.projections,
          terminals: deps.terminals,
          normalizeFollowup: deps.normalize,
        }),
      ),
      Effect.mapError(toDispatchError),
    ),
  );
  // An archive replay still runs its idempotent follow-ups (stopping the
  // session, closing terminals) in case the first attempt was cut off between
  // commit and cleanup; its normalization depends on nothing a first attempt
  // consumes.
  const answered =
    !deps.receipts || deps.command.type === "thread.archive"
      ? apply
      : priorCommandOutcome(deps.receipts, deps.command).pipe(
          Effect.flatMap((prior) => (Option.isSome(prior) ? Effect.succeed(prior.value) : apply)),
        );
  return deps.flights ? deps.flights.join(deps.command.commandId, answered) : answered;
};

const makeOrchestrationCommandApplication = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const terminals = yield* TerminalManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const workspaceAccessPolicy = yield* WorkspaceAccessPolicy;
  const workspacePaths = yield* WorkspacePaths;
  const receipts = yield* OrchestrationCommandReceiptRepository;

  const engineDispatcher: OrchestrationNormalizedCommandDispatcher = (command) =>
    engine.dispatch(command).pipe(Effect.mapError(toDispatchError));

  const normalize = (command: Parameters<OrchestrationCommandApplicationShape["apply"]>[0]) =>
    normalizeDispatchCommand(command).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.provideService(WorkspaceAccessPolicy, workspaceAccessPolicy),
      Effect.provideService(WorkspacePaths, workspacePaths),
    );

  const applyWithDispatcher: OrchestrationCommandApplicationShape["applyWithDispatcher"] = (
    command,
    dispatch,
  ) =>
    applyOrchestrationCommand({ command, normalize, dispatch, projections, terminals, receipts });

  const apply: OrchestrationCommandApplicationShape["apply"] = (command) =>
    applyWithDispatcher(command, engineDispatcher);

  return { apply, applyWithDispatcher } satisfies OrchestrationCommandApplicationShape;
});

export const OrchestrationCommandApplicationLive = Layer.effect(
  OrchestrationCommandApplication,
  makeOrchestrationCommandApplication,
);
