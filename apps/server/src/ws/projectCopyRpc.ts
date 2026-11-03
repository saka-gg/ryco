import { WS_METHODS } from "@ryco/contracts";
import { ProjectCopyError } from "@ryco/contracts/project-copy";
import { Effect, Option } from "effect";

import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation.ts";
import type { ProjectCopyCallerChannel } from "../projectCopy/callerChannel.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";
import type { RpcConnectionFacts } from "./RpcPrincipal.ts";

const TRACE_ATTRIBUTES = { "rpc.aggregate": "project-copy" } as const;

// The connection classifier loads with the first call that needs it, never at boot.
const loadConnectionPath = Effect.promise(() => import("./rpcConnectionPath.ts"));

/**
 * How the caller's bytes reach this node, classified from the facts the node captured when the
 * connection was built (`RpcPrincipal.connection`), by the same rule as secret answers: only an
 * end-to-end encrypted relay channel, TLS, Tailscale or this machine counts as encrypted. A
 * plaintext relay, plain `ws://` from another machine and a connection without facts do not.
 */
export const projectCopyCallerChannel = (
  connection: RpcConnectionFacts | undefined,
  readNodeTailscaleAddresses: Effect.Effect<ReadonlyArray<string> | undefined> = Effect.succeed(
    undefined,
  ),
): Effect.Effect<ProjectCopyCallerChannel> =>
  loadConnectionPath.pipe(
    Effect.flatMap((module) =>
      module
        .readRpcConnectionPath(connection, readNodeTailscaleAddresses)
        .pipe(
          Effect.map((path) =>
            module.isEncryptedConnectionPath(path)
              ? ("encrypted" as const)
              : ("unencrypted" as const),
          ),
        ),
    ),
  );

/**
 * Cross-node project copy RPCs: reads and scratch transfers on either node, the durable import
 * job on the destination. Each one passes the access check, then delegates to its service. The
 * export's `start` and `readChunk` and the transfer's `begin` and `append` learn how the caller's
 * bytes travel, so opted-in ignored files never cross a plaintext relay on either leg (A33).
 */
export const makeProjectCopyHandlers = (ctx: WsRpcContext) => {
  const { ownerEffect, ownerStreamEffect, projectCopy } = ctx;
  const callerChannel = projectCopyCallerChannel(ctx.connection, ctx.readNodeTailscaleAddresses);

  // Absent only in route tests that leave the project copy services out.
  const service = <S>(option: Option.Option<S>): Effect.Effect<S, ProjectCopyError> =>
    Option.match(option, {
      onNone: () =>
        Effect.fail(
          new ProjectCopyError({
            code: "unavailable",
            message: "Project copy is unavailable on this node.",
          }),
        ),
      onSome: Effect.succeed,
    });
  const nodePaths = service(projectCopy.nodePaths);
  const gitNetwork = service(projectCopy.gitNetwork);
  const exporter = service(projectCopy.projectExport);
  const transfers = service(projectCopy.projectTransfers);
  const imports = service(projectCopy.projectImports);

  const handle = <A>(method: string, effect: Effect.Effect<A, ProjectCopyError>) =>
    observeRpcEffect(method, ownerEffect(method, effect), TRACE_ATTRIBUTES);

  return defineWsHandlers({
    [WS_METHODS.projectsPathHints]: (input) =>
      handle(
        WS_METHODS.projectsPathHints,
        nodePaths.pipe(Effect.flatMap((paths) => paths.pathHints(input))),
      ),
    [WS_METHODS.filesystemSearchDirectories]: (input) =>
      handle(
        WS_METHODS.filesystemSearchDirectories,
        nodePaths.pipe(Effect.flatMap((paths) => paths.searchDirectories(input))),
      ),
    [WS_METHODS.projectsPreviewDestination]: (input) =>
      handle(
        WS_METHODS.projectsPreviewDestination,
        nodePaths.pipe(Effect.flatMap((paths) => paths.previewDestination(input))),
      ),
    [WS_METHODS.projectsCheckRemoteAccess]: (input) =>
      handle(
        WS_METHODS.projectsCheckRemoteAccess,
        gitNetwork.pipe(Effect.flatMap((git) => git.checkRemoteAccess(input))),
      ),
    [WS_METHODS.projectsExportInspect]: (input) =>
      handle(
        WS_METHODS.projectsExportInspect,
        exporter.pipe(Effect.flatMap((source) => source.inspect(input))),
      ),
    [WS_METHODS.projectsExportStart]: (input) =>
      handle(
        WS_METHODS.projectsExportStart,
        exporter.pipe(
          Effect.flatMap((source) =>
            callerChannel.pipe(Effect.flatMap((channel) => source.start({ input, channel }))),
          ),
        ),
      ),
    [WS_METHODS.projectsExportReadChunk]: (input) =>
      handle(
        WS_METHODS.projectsExportReadChunk,
        exporter.pipe(
          Effect.flatMap((source) =>
            callerChannel.pipe(Effect.flatMap((channel) => source.readChunk(input, channel))),
          ),
        ),
      ),
    [WS_METHODS.projectsExportDispose]: (input) =>
      handle(
        WS_METHODS.projectsExportDispose,
        exporter.pipe(
          Effect.flatMap((source) => source.dispose(input)),
          Effect.as({}),
        ),
      ),
    [WS_METHODS.projectsTransferBegin]: (input) =>
      handle(
        WS_METHODS.projectsTransferBegin,
        transfers.pipe(
          Effect.flatMap((uploads) =>
            callerChannel.pipe(Effect.flatMap((channel) => uploads.begin(input, channel))),
          ),
        ),
      ),
    [WS_METHODS.projectsTransferAppend]: (input) =>
      handle(
        WS_METHODS.projectsTransferAppend,
        transfers.pipe(
          Effect.flatMap((uploads) =>
            callerChannel.pipe(Effect.flatMap((channel) => uploads.append(input, channel))),
          ),
        ),
      ),
    [WS_METHODS.projectsTransferCommit]: (input) =>
      handle(
        WS_METHODS.projectsTransferCommit,
        transfers.pipe(Effect.flatMap((uploads) => uploads.commit(input))),
      ),
    [WS_METHODS.projectsTransferAbort]: (input) =>
      handle(
        WS_METHODS.projectsTransferAbort,
        transfers.pipe(
          Effect.flatMap((uploads) => uploads.abort(input)),
          Effect.as({}),
        ),
      ),
    [WS_METHODS.projectsImportStart]: (input) =>
      handle(
        WS_METHODS.projectsImportStart,
        imports.pipe(Effect.flatMap((jobs) => jobs.start(input))),
      ),
    [WS_METHODS.projectsSubscribeImport]: (input) =>
      observeRpcStreamEffect(
        WS_METHODS.projectsSubscribeImport,
        ownerStreamEffect(
          WS_METHODS.projectsSubscribeImport,
          imports.pipe(Effect.map((jobs) => jobs.subscribe(input))),
        ),
        TRACE_ATTRIBUTES,
      ),
    [WS_METHODS.projectsCancelImport]: (input) =>
      handle(
        WS_METHODS.projectsCancelImport,
        imports.pipe(Effect.flatMap((jobs) => jobs.cancel(input))),
      ),
    [WS_METHODS.projectsListImports]: (input) =>
      handle(
        WS_METHODS.projectsListImports,
        imports.pipe(Effect.flatMap((jobs) => jobs.list(input))),
      ),
    [WS_METHODS.projectsDiscardImport]: (input) =>
      handle(
        WS_METHODS.projectsDiscardImport,
        imports.pipe(Effect.flatMap((jobs) => jobs.discard(input))),
      ),
  });
};
