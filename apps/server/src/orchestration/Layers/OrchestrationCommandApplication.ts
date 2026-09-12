import {
  CommandId,
  OrchestrationDispatchCommandError,
  type OrchestrationCommand,
} from "@ryco/contracts";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { ServerConfig } from "../../config.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import type { TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import { WorkspaceAccessPolicy } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
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

export const applyOrchestrationCommand = <R>(deps: {
  readonly command: Parameters<OrchestrationCommandApplicationShape["apply"]>[0];
  readonly normalize: (
    command: Parameters<OrchestrationCommandApplicationShape["apply"]>[0],
  ) => Effect.Effect<OrchestrationCommand, OrchestrationDispatchCommandError, R>;
  readonly dispatch: OrchestrationNormalizedCommandDispatcher;
  readonly projections: ProjectionSnapshotQueryShape;
  readonly terminals: TerminalManagerShape;
}) =>
  withChatAttachmentAdoption(
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

const makeOrchestrationCommandApplication = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const terminals = yield* TerminalManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const workspaceAccessPolicy = yield* WorkspaceAccessPolicy;
  const workspacePaths = yield* WorkspacePaths;

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
  ) => applyOrchestrationCommand({ command, normalize, dispatch, projections, terminals });

  const apply: OrchestrationCommandApplicationShape["apply"] = (command) =>
    applyWithDispatcher(command, engineDispatcher);

  return { apply, applyWithDispatcher } satisfies OrchestrationCommandApplicationShape;
});

export const OrchestrationCommandApplicationLive = Layer.effect(
  OrchestrationCommandApplication,
  makeOrchestrationCommandApplication,
);
