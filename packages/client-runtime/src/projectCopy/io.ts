/**
 * What the copy coordinator needs from the app, injected so the coordinator stays free of web,
 * DOM and React Native code: a way to retain each node for the copy, the node's current API
 * behind a mutation-lease check (A22), a clock and an id source.
 *
 * Nodes never talk to each other; the client holds both connections and drives every call.
 *
 * @module projectCopy/io
 */
import type { EnvironmentApi, EnvironmentId } from "@ryco/contracts";
import type { ProjectCopyErrorCode } from "@ryco/contracts/project-copy";

/**
 * The slice of a node's `EnvironmentApi` a copy uses. `EnvironmentApi` satisfies it as it is;
 * every project-copy member is optional because nodes without `capabilities.projectCopy` lack
 * them.
 */
export interface ProjectCopyNodeApi {
  readonly projects: Pick<
    EnvironmentApi["projects"],
    | "pathHints"
    | "previewDestination"
    | "checkRemoteAccess"
    | "exportInspect"
    | "exportStart"
    | "exportReadChunk"
    | "exportDispose"
    | "transferBegin"
    | "transferAppend"
    | "transferCommit"
    | "transferAbort"
    | "importStart"
    | "subscribeImport"
    | "cancelImport"
    | "listImports"
    | "discardImport"
  >;
  readonly orchestration: Pick<EnvironmentApi["orchestration"], "dispatchCommand">;
  /** The node's server config, for resolving the follow-up thread's model (A19). */
  readonly server?: Pick<NonNullable<EnvironmentApi["server"]>, "getConfig"> | undefined;
}

/** How this client reaches a node. A relayed node caps the artifacts of one copy (A7). */
export type ProjectCopyTransport = "direct" | "relay";

/**
 * Why a node is retained. `copy` holds the non-preemptible `project-copy` connection scope and,
 * in hosted mode, the mutation lease; `follow` is the view scope that following an import
 * needs once the import runs on its own.
 */
export type ProjectCopyNodePurpose = "copy" | "follow";

export interface ProjectCopyNodeHandle {
  readonly environmentId: EnvironmentId;
  readonly transport: ProjectCopyTransport;
  /** Drops the scope the handle retains. Idempotent. */
  readonly release: () => void;
}

export interface ProjectCopyAcquireRequest {
  readonly environmentId: EnvironmentId;
  readonly copyId: string;
  readonly purpose: ProjectCopyNodePurpose;
  /** Aborted when the copy is cancelled. */
  readonly signal: AbortSignal;
}

export interface ProjectCopyIo {
  /**
   * Wakes and retains the node, awaits its bootstrap and, for `copy` in hosted mode, the
   * mutation lease. Rejects with {@link ProjectCopyNodeUnavailableError} when that takes longer
   * than about 30 s ("All connections are in use; close a view on another device").
   */
  readonly acquireNode: (request: ProjectCopyAcquireRequest) => Promise<ProjectCopyNodeHandle>;
  /**
   * Runs one call that changes node state against the node's current API, after checking that
   * the node's mutation lease is still current. When it is not, it rejects with
   * {@link ProjectCopyLeaseLostError} without calling, so the call never went out. It never
   * hands out an API from an earlier connection generation.
   */
  readonly withLease: <T>(
    environmentId: EnvironmentId,
    call: (api: ProjectCopyNodeApi) => Promise<T>,
  ) => Promise<T>;
  /**
   * Runs one read (or opens a subscription) against the node's current API; no lease is
   * needed. Rejects with {@link ProjectCopyNodeUnavailableError} when the node is not
   * connected.
   *
   * `connectionLost` aborts once that API's connection stops being the node's connection (it
   * was replaced or dropped, or the hold was released). A subscription opened through it then
   * ends without calling its `onError`, so whoever waits on one listens to this signal too.
   */
  readonly withNode: <T>(
    environmentId: EnvironmentId,
    call: (api: ProjectCopyNodeApi, connectionLost: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** A lowercase random (version 4) UUID, like `crypto.randomUUID()`. */
  readonly uuid: () => string;
  /** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The node's mutation lease is no longer current; the call did not go out. */
export class ProjectCopyLeaseLostError extends Error {
  readonly _tag = "ProjectCopyLeaseLostError";
  readonly environmentId: EnvironmentId;

  constructor(environmentId: EnvironmentId, message = "The connection to the node changed.") {
    super(message);
    this.name = "ProjectCopyLeaseLostError";
    this.environmentId = environmentId;
  }
}

/** The node could not be reached or retained (offline, or every connection is in use). */
export class ProjectCopyNodeUnavailableError extends Error {
  readonly _tag = "ProjectCopyNodeUnavailableError";
  readonly environmentId: EnvironmentId;

  constructor(environmentId: EnvironmentId, message: string) {
    super(message);
    this.name = "ProjectCopyNodeUnavailableError";
    this.environmentId = environmentId;
  }
}

const hasTag = (error: unknown, tag: string): boolean =>
  typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === tag;

export const isProjectCopyLeaseLostError = (error: unknown): error is ProjectCopyLeaseLostError =>
  hasTag(error, "ProjectCopyLeaseLostError");

export const isProjectCopyNodeUnavailableError = (
  error: unknown,
): error is ProjectCopyNodeUnavailableError => hasTag(error, "ProjectCopyNodeUnavailableError");

/** A node's `ProjectCopyError` as an RPC call rejects with it: a definite answer, not a drop. */
export interface ProjectCopyRpcError {
  readonly _tag: "ProjectCopyError";
  readonly code: ProjectCopyErrorCode;
  readonly message: string;
  readonly receivedBytes?: number | undefined;
}

export const isProjectCopyRpcError = (error: unknown): error is ProjectCopyRpcError =>
  hasTag(error, "ProjectCopyError") && typeof (error as { code?: unknown }).code === "string";
