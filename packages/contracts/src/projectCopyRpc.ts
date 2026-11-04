/**
 * The cross-node project copy RPCs: reads and scratch transfers on either node,
 * the durable import job on the destination. A node announces them with
 * `ExecutionEnvironmentCapabilities.projectCopy`; their method names are
 * `PROJECT_COPY_WS_METHODS` (`@ryco/contracts/project-copy-methods`).
 *
 * The group also carries the two Agent Control RPCs only cross-node copy uses:
 * the client-executed copy's reports and the node directory owner clients
 * publish (`agentControlProjectCopy.ts`).
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

import { AGENT_CONTROL_WS_METHODS, AgentControlRpcError } from "./agentControl.ts";
import {
  AgentControlPublishNodeDirectoryInput,
  AgentControlPublishNodeDirectoryResult,
  AgentControlReportClientExecutionInput,
  AgentControlReportClientExecutionResult,
} from "./agentControlProjectCopy.ts";
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
import { PROJECT_COPY_WS_METHODS } from "./projectCopyMethods.ts";
import { EmptyRpcResult, WsHostedRpcGroup, WsRpcGroup } from "./rpc.ts";

const ProjectCopyRpcError = Schema.Union([ProjectCopyError, AuthRpcError]);

export const WsProjectsPathHintsRpc = Rpc.make(PROJECT_COPY_WS_METHODS.pathHints, {
  payload: NodePathHintsInput,
  success: NodePathHints,
  error: ProjectCopyRpcError,
});

export const WsFilesystemSearchDirectoriesRpc = Rpc.make(
  PROJECT_COPY_WS_METHODS.searchDirectories,
  {
    payload: FilesystemSearchDirectoriesInput,
    success: FilesystemSearchDirectoriesResult,
    error: ProjectCopyRpcError,
  },
);

export const WsProjectsPreviewDestinationRpc = Rpc.make(
  PROJECT_COPY_WS_METHODS.previewDestination,
  {
    payload: ProjectDestinationPreviewInput,
    success: ProjectDestinationPreview,
    error: ProjectCopyRpcError,
  },
);

export const WsProjectsCheckRemoteAccessRpc = Rpc.make(PROJECT_COPY_WS_METHODS.checkRemoteAccess, {
  payload: ProjectCheckRemoteAccessInput,
  success: ProjectCheckRemoteAccessResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsExportInspectRpc = Rpc.make(PROJECT_COPY_WS_METHODS.exportInspect, {
  payload: ProjectExportInspectInput,
  success: ProjectExportInspection,
  error: ProjectCopyRpcError,
});

export const WsProjectsExportStartRpc = Rpc.make(PROJECT_COPY_WS_METHODS.exportStart, {
  payload: ProjectExportStartInput,
  success: ProjectExportResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsExportReadChunkRpc = Rpc.make(PROJECT_COPY_WS_METHODS.exportReadChunk, {
  payload: ProjectExportReadChunkInput,
  success: ProjectExportReadChunkResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsExportDisposeRpc = Rpc.make(PROJECT_COPY_WS_METHODS.exportDispose, {
  payload: ProjectExportDisposeInput,
  success: EmptyRpcResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsTransferBeginRpc = Rpc.make(PROJECT_COPY_WS_METHODS.transferBegin, {
  payload: ProjectTransferBeginInput,
  success: ProjectTransferProgress,
  error: ProjectCopyRpcError,
});

export const WsProjectsTransferAppendRpc = Rpc.make(PROJECT_COPY_WS_METHODS.transferAppend, {
  payload: ProjectTransferAppendInput,
  success: ProjectTransferProgress,
  error: ProjectCopyRpcError,
});

export const WsProjectsTransferCommitRpc = Rpc.make(PROJECT_COPY_WS_METHODS.transferCommit, {
  payload: ProjectTransferCommitInput,
  success: ProjectTransferCommitResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsTransferAbortRpc = Rpc.make(PROJECT_COPY_WS_METHODS.transferAbort, {
  payload: ProjectTransferAbortInput,
  success: EmptyRpcResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsImportStartRpc = Rpc.make(PROJECT_COPY_WS_METHODS.importStart, {
  payload: ProjectImportStartInput,
  success: ProjectImportSnapshot,
  error: ProjectCopyRpcError,
});

export const WsProjectsSubscribeImportRpc = Rpc.make(PROJECT_COPY_WS_METHODS.subscribeImport, {
  payload: ProjectSubscribeImportInput,
  success: ProjectImportSnapshot,
  error: ProjectCopyRpcError,
  stream: true,
});

export const WsProjectsCancelImportRpc = Rpc.make(PROJECT_COPY_WS_METHODS.cancelImport, {
  payload: ProjectCancelImportInput,
  success: ProjectImportSnapshot,
  error: ProjectCopyRpcError,
});

export const WsProjectsListImportsRpc = Rpc.make(PROJECT_COPY_WS_METHODS.listImports, {
  payload: ProjectListImportsInput,
  success: ProjectListImportsResult,
  error: ProjectCopyRpcError,
});

export const WsProjectsDiscardImportRpc = Rpc.make(PROJECT_COPY_WS_METHODS.discardImport, {
  payload: ProjectDiscardImportInput,
  success: ProjectDiscardImportResult,
  error: ProjectCopyRpcError,
});

export const WsAgentControlReportClientExecutionRpc = Rpc.make(
  AGENT_CONTROL_WS_METHODS.reportClientExecution,
  {
    payload: AgentControlReportClientExecutionInput,
    success: AgentControlReportClientExecutionResult,
    error: Schema.Union([AgentControlRpcError, AuthRpcError]),
  },
);

export const WsAgentControlPublishNodeDirectoryRpc = Rpc.make(
  AGENT_CONTROL_WS_METHODS.publishNodeDirectory,
  {
    payload: AgentControlPublishNodeDirectoryInput,
    success: AgentControlPublishNodeDirectoryResult,
    error: Schema.Union([AgentControlRpcError, AuthRpcError]),
  },
);

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
  WsAgentControlReportClientExecutionRpc,
  WsAgentControlPublishNodeDirectoryRpc,
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
