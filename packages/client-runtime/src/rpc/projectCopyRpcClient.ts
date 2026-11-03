import type { ProjectImportSnapshot } from "@ryco/contracts/project-copy";
import { WsProjectCopyRpcGroup } from "@ryco/contracts/project-copy-rpc";
import { WS_METHODS } from "@ryco/contracts/rpc";
import type * as Effect from "effect/Effect";
import * as RpcClient from "effect/rpc/RpcClient";

import type { SubscriptionFailureKind, WsTransport } from "./wsTransport.ts";

/**
 * The cross-node project copy RPCs' client. `createWsRpcClient` loads this
 * module with the first copy call, so the copy RPC schemas never load at boot;
 * the client rides the connection's own socket (`RpcTransport.withClient`).
 */
export const makeProjectCopyRpcProtocolClient = RpcClient.make(WsProjectCopyRpcGroup);
type ProjectCopyRpcClientFactory = typeof makeProjectCopyRpcProtocolClient;
export type ProjectCopyRpcProtocolClient =
  ProjectCopyRpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

type CopyTag = keyof ProjectCopyRpcProtocolClient & string;
type CopyInput<TTag extends CopyTag> = Parameters<ProjectCopyRpcProtocolClient[TTag]>[0];
type CopyUnaryMethod<TTag extends CopyTag> = ProjectCopyRpcProtocolClient[TTag] extends (
  input: any,
  options?: any,
) => Effect.Effect<infer TSuccess, any, any>
  ? (input: CopyInput<TTag>) => Promise<TSuccess>
  : never;
export interface ProjectCopyStreamOptions {
  readonly onResubscribe?: () => void;
  readonly onError?: (kind?: SubscriptionFailureKind) => void;
  readonly classifyFailure?: (error: unknown) => SubscriptionFailureKind;
}

/** What `WsRpcClient` exposes of the copy RPCs; see `createWsRpcClient`. */
export interface ProjectCopyRpcMethods {
  readonly pathHints: CopyUnaryMethod<typeof WS_METHODS.projectsPathHints>;
  readonly searchDirectories: CopyUnaryMethod<typeof WS_METHODS.filesystemSearchDirectories>;
  readonly previewDestination: CopyUnaryMethod<typeof WS_METHODS.projectsPreviewDestination>;
  readonly checkRemoteAccess: CopyUnaryMethod<typeof WS_METHODS.projectsCheckRemoteAccess>;
  readonly exportInspect: CopyUnaryMethod<typeof WS_METHODS.projectsExportInspect>;
  readonly exportStart: CopyUnaryMethod<typeof WS_METHODS.projectsExportStart>;
  readonly exportReadChunk: CopyUnaryMethod<typeof WS_METHODS.projectsExportReadChunk>;
  readonly exportDispose: CopyUnaryMethod<typeof WS_METHODS.projectsExportDispose>;
  readonly transferBegin: CopyUnaryMethod<typeof WS_METHODS.projectsTransferBegin>;
  readonly transferAppend: CopyUnaryMethod<typeof WS_METHODS.projectsTransferAppend>;
  readonly transferCommit: CopyUnaryMethod<typeof WS_METHODS.projectsTransferCommit>;
  readonly transferAbort: CopyUnaryMethod<typeof WS_METHODS.projectsTransferAbort>;
  readonly importStart: CopyUnaryMethod<typeof WS_METHODS.projectsImportStart>;
  readonly subscribeImport: (
    input: CopyInput<typeof WS_METHODS.projectsSubscribeImport>,
    listener: (snapshot: ProjectImportSnapshot) => void,
    options?: ProjectCopyStreamOptions,
  ) => () => void;
  readonly cancelImport: CopyUnaryMethod<typeof WS_METHODS.projectsCancelImport>;
  readonly listImports: CopyUnaryMethod<typeof WS_METHODS.projectsListImports>;
  readonly discardImport: CopyUnaryMethod<typeof WS_METHODS.projectsDiscardImport>;
}

export function createProjectCopyRpcMethods(
  transport: Pick<WsTransport, "withClient">,
): ProjectCopyRpcMethods {
  const copy = transport.withClient(makeProjectCopyRpcProtocolClient);
  return {
    pathHints: (input) => copy.request((client) => client[WS_METHODS.projectsPathHints](input)),
    searchDirectories: (input) =>
      copy.request((client) => client[WS_METHODS.filesystemSearchDirectories](input)),
    previewDestination: (input) =>
      copy.request((client) => client[WS_METHODS.projectsPreviewDestination](input)),
    checkRemoteAccess: (input) =>
      copy.request((client) => client[WS_METHODS.projectsCheckRemoteAccess](input)),
    exportInspect: (input) =>
      copy.request((client) => client[WS_METHODS.projectsExportInspect](input)),
    exportStart: (input) => copy.request((client) => client[WS_METHODS.projectsExportStart](input)),
    exportReadChunk: (input) =>
      copy.request((client) => client[WS_METHODS.projectsExportReadChunk](input)),
    exportDispose: (input) =>
      copy.request((client) => client[WS_METHODS.projectsExportDispose](input)),
    transferBegin: (input) =>
      copy.request((client) => client[WS_METHODS.projectsTransferBegin](input)),
    transferAppend: (input) =>
      copy.request((client) => client[WS_METHODS.projectsTransferAppend](input)),
    transferCommit: (input) =>
      copy.request((client) => client[WS_METHODS.projectsTransferCommit](input)),
    transferAbort: (input) =>
      copy.request((client) => client[WS_METHODS.projectsTransferAbort](input)),
    importStart: (input) => copy.request((client) => client[WS_METHODS.projectsImportStart](input)),
    subscribeImport: (input, listener, options) =>
      copy.subscribe((client) => client[WS_METHODS.projectsSubscribeImport](input), listener, {
        ...options,
        tag: WS_METHODS.projectsSubscribeImport,
      }),
    cancelImport: (input) =>
      copy.request((client) => client[WS_METHODS.projectsCancelImport](input)),
    listImports: (input) => copy.request((client) => client[WS_METHODS.projectsListImports](input)),
    discardImport: (input) =>
      copy.request((client) => client[WS_METHODS.projectsDiscardImport](input)),
  };
}
