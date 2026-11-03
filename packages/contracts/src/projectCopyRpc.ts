/**
 * The cross-node project copy RPCs: reads and scratch transfers on either node,
 * the durable import job on the destination. A node announces them with
 * `ExecutionEnvironmentCapabilities.projectCopy`; their method names stay in
 * `WS_METHODS`.
 *
 * They are a group of their own so the app's boot never loads their schemas:
 * the server merges `WsProjectCopyRpcGroup` into what it serves (`WsNodeRpcGroup`)
 * the way it merges the device group, and a client builds this group's RPC
 * client on the socket it already has the first time a copy calls one.
 *
 * Exported as `@ryco/contracts/project-copy-rpc`, not from the package root.
 *
 * @module projectCopyRpc
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { AuthRpcError } from "./auth.ts";
import {
  FilesystemSearchDirectoriesInput,
  FilesystemSearchDirectoriesResult,
  NodePathHints,
  NodePathHintsInput,
  ProjectCancelImportInput,
  ProjectCheckRemoteAccessInput,
  ProjectCheckRemoteAccessResult,
  ProjectCopyError,
  ProjectDestinationPreview,
  ProjectDestinationPreviewInput,
  ProjectDiscardImportInput,
  ProjectDiscardImportResult,
  ProjectExportDisposeInput,
  ProjectExportInspectInput,
  ProjectExportInspection,
  ProjectExportReadChunkInput,
  ProjectExportReadChunkResult,
  ProjectExportResult,
  ProjectExportStartInput,
  ProjectImportSnapshot,
  ProjectImportStartInput,
  ProjectListImportsInput,
  ProjectListImportsResult,
  ProjectSubscribeImportInput,
  ProjectTransferAbortInput,
  ProjectTransferAppendInput,
  ProjectTransferBeginInput,
  ProjectTransferCommitInput,
  ProjectTransferCommitResult,
  ProjectTransferProgress,
} from "./projectCopy.ts";
import { EmptyRpcResult, WS_METHODS, WsHostedRpcGroup, WsRpcGroup } from "./rpc.ts";

const ProjectCopyRpcError = Schema.Union([ProjectCopyError, AuthRpcError]);

export const WsProjectsPathHintsRpc = Rpc.make(WS_METHODS.projectsPathHints, {
  payload: NodePathHintsInput,
  success: NodePathHints,
  error: ProjectCopyRpcError,
});

export const WsFilesystemSearchDirectoriesRpc = Rpc.make(WS_METHODS.filesystemSearchDirectories, {
  payload: FilesystemSearchDirectoriesInput,
  success: FilesystemSearchDirectoriesResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsPreviewDestinationRpc = Rpc.make(WS_METHODS.projectsPreviewDestination, {
  payload: ProjectDestinationPreviewInput,
  success: ProjectDestinationPreview,
  error: ProjectCopyRpcError,
});

export const WsProjectsCheckRemoteAccessRpc = Rpc.make(WS_METHODS.projectsCheckRemoteAccess, {
  payload: ProjectCheckRemoteAccessInput,
  success: ProjectCheckRemoteAccessResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsExportInspectRpc = Rpc.make(WS_METHODS.projectsExportInspect, {
  payload: ProjectExportInspectInput,
  success: ProjectExportInspection,
  error: ProjectCopyRpcError,
});

export const WsProjectsExportStartRpc = Rpc.make(WS_METHODS.projectsExportStart, {
  payload: ProjectExportStartInput,
  success: ProjectExportResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsExportReadChunkRpc = Rpc.make(WS_METHODS.projectsExportReadChunk, {
  payload: ProjectExportReadChunkInput,
  success: ProjectExportReadChunkResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsExportDisposeRpc = Rpc.make(WS_METHODS.projectsExportDispose, {
  payload: ProjectExportDisposeInput,
  success: EmptyRpcResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsTransferBeginRpc = Rpc.make(WS_METHODS.projectsTransferBegin, {
  payload: ProjectTransferBeginInput,
  success: ProjectTransferProgress,
  error: ProjectCopyRpcError,
});

export const WsProjectsTransferAppendRpc = Rpc.make(WS_METHODS.projectsTransferAppend, {
  payload: ProjectTransferAppendInput,
  success: ProjectTransferProgress,
  error: ProjectCopyRpcError,
});

export const WsProjectsTransferCommitRpc = Rpc.make(WS_METHODS.projectsTransferCommit, {
  payload: ProjectTransferCommitInput,
  success: ProjectTransferCommitResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsTransferAbortRpc = Rpc.make(WS_METHODS.projectsTransferAbort, {
  payload: ProjectTransferAbortInput,
  success: EmptyRpcResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsImportStartRpc = Rpc.make(WS_METHODS.projectsImportStart, {
  payload: ProjectImportStartInput,
  success: ProjectImportSnapshot,
  error: ProjectCopyRpcError,
});

export const WsProjectsSubscribeImportRpc = Rpc.make(WS_METHODS.projectsSubscribeImport, {
  payload: ProjectSubscribeImportInput,
  success: ProjectImportSnapshot,
  error: ProjectCopyRpcError,
  stream: true,
});

export const WsProjectsCancelImportRpc = Rpc.make(WS_METHODS.projectsCancelImport, {
  payload: ProjectCancelImportInput,
  success: ProjectImportSnapshot,
  error: ProjectCopyRpcError,
});

export const WsProjectsListImportsRpc = Rpc.make(WS_METHODS.projectsListImports, {
  payload: ProjectListImportsInput,
  success: ProjectListImportsResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsDiscardImportRpc = Rpc.make(WS_METHODS.projectsDiscardImport, {
  payload: ProjectDiscardImportInput,
  success: ProjectDiscardImportResult,
  error: ProjectCopyRpcError,
});

export const WsProjectCopyRpcGroup = RpcGroup.make(
  WsProjectsPathHintsRpc,
  WsFilesystemSearchDirectoriesRpc,
  WsProjectsPreviewDestinationRpc,
  WsProjectsCheckRemoteAccessRpc,
  WsProjectsExportInspectRpc,
  WsProjectsExportStartRpc,
  WsProjectsExportReadChunkRpc,
  WsProjectsExportDisposeRpc,
  WsProjectsTransferBeginRpc,
  WsProjectsTransferAppendRpc,
  WsProjectsTransferCommitRpc,
  WsProjectsTransferAbortRpc,
  WsProjectsImportStartRpc,
  WsProjectsSubscribeImportRpc,
  WsProjectsCancelImportRpc,
  WsProjectsListImportsRpc,
  WsProjectsDiscardImportRpc,
);

/**
 * The application group with the copy RPCs: what a node's application handlers
 * serve. The explicit annotations keep the merged unions within the compiler's
 * serializable type limit.
 */
export const WsApplicationRpcGroup: RpcGroup.RpcGroup<
  RpcGroup.Rpcs<typeof WsRpcGroup> | RpcGroup.Rpcs<typeof WsProjectCopyRpcGroup>
> = WsRpcGroup.merge(WsProjectCopyRpcGroup);

/**
 * Everything a current node serves on its main socket and its relay channels:
 * the hosted group (application and device RPCs) and the copy RPCs.
 */
export const WsNodeRpcGroup: RpcGroup.RpcGroup<
  RpcGroup.Rpcs<typeof WsHostedRpcGroup> | RpcGroup.Rpcs<typeof WsProjectCopyRpcGroup>
> = WsHostedRpcGroup.merge(WsProjectCopyRpcGroup);
