import { AGENT_CONTROL_WS_METHODS } from "@ryco/contracts/agent-control";
import type { ProjectImportSnapshot } from "@ryco/contracts/project-copy";
import { WsProjectCopyRpcGroup } from "@ryco/contracts/project-copy-rpc";
import { PROJECT_COPY_WS_METHODS } from "@ryco/contracts/project-copy-methods";
import type * as Effect from "effect/Effect";
import * as RpcClient from "effect/rpc/RpcClient";

import type { SubscriptionFailureKind, WsTransport } from "./wsTransport.ts";

/**
 * The cross-node project copy RPCs' client, with the two Agent Control RPCs
 * only cross-node copy uses (the copy's reports and the node directory).
 * `createWsRpcClient` loads this module with the first of those calls, so their
 * schemas never load at boot; the client rides the connection's own socket
 * (`RpcTransport.withClient`).
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
  readonly pathHints: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.pathHints>;
  readonly searchDirectories: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.searchDirectories>;
  readonly previewDestination: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.previewDestination>;
  readonly checkRemoteAccess: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.checkRemoteAccess>;
  readonly exportInspect: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.exportInspect>;
  readonly exportStart: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.exportStart>;
  readonly exportReadChunk: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.exportReadChunk>;
  readonly exportDispose: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.exportDispose>;
  readonly transferBegin: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.transferBegin>;
  readonly transferAppend: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.transferAppend>;
  readonly transferCommit: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.transferCommit>;
  readonly transferAbort: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.transferAbort>;
  readonly importStart: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.importStart>;
  readonly subscribeImport: (
    input: CopyInput<typeof PROJECT_COPY_WS_METHODS.subscribeImport>,
    listener: (snapshot: ProjectImportSnapshot) => void,
    options?: ProjectCopyStreamOptions,
  ) => () => void;
  readonly cancelImport: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.cancelImport>;
  readonly listImports: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.listImports>;
  readonly discardImport: CopyUnaryMethod<typeof PROJECT_COPY_WS_METHODS.discardImport>;
  readonly publishNodeDirectory: CopyUnaryMethod<
    typeof AGENT_CONTROL_WS_METHODS.publishNodeDirectory
  >;
  readonly reportClientExecution: CopyUnaryMethod<
    typeof AGENT_CONTROL_WS_METHODS.reportClientExecution
  >;
}

export function createProjectCopyRpcMethods(
  transport: Pick<WsTransport, "withClient">,
): ProjectCopyRpcMethods {
  const copy = transport.withClient(makeProjectCopyRpcProtocolClient);
  return {
    pathHints: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.pathHints](input)),
    searchDirectories: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.searchDirectories](input)),
    previewDestination: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.previewDestination](input)),
    checkRemoteAccess: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.checkRemoteAccess](input)),
    exportInspect: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.exportInspect](input)),
    exportStart: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.exportStart](input)),
    exportReadChunk: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.exportReadChunk](input)),
    exportDispose: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.exportDispose](input)),
    transferBegin: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.transferBegin](input)),
    transferAppend: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.transferAppend](input)),
    transferCommit: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.transferCommit](input)),
    transferAbort: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.transferAbort](input)),
    importStart: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.importStart](input)),
    subscribeImport: (input, listener, options) =>
      copy.subscribe((client) => client[PROJECT_COPY_WS_METHODS.subscribeImport](input), listener, {
        ...options,
        tag: PROJECT_COPY_WS_METHODS.subscribeImport,
      }),
    cancelImport: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.cancelImport](input)),
    listImports: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.listImports](input)),
    discardImport: (input) =>
      copy.request((client) => client[PROJECT_COPY_WS_METHODS.discardImport](input)),
    publishNodeDirectory: (input) =>
      copy.request((client) => client[AGENT_CONTROL_WS_METHODS.publishNodeDirectory](input)),
    reportClientExecution: (input) =>
      copy.request((client) => client[AGENT_CONTROL_WS_METHODS.reportClientExecution](input)),
  };
}
