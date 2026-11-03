/**
 * Runs one cross-node copy against two nodes: acquire → export on the source → chunked
 * transfers to the target → `projects.importStart` → follow the import → dispose the export.
 *
 * - Every id is minted here and kept in the job record, so each call is idempotent by its id
 *   and a reload resumes with the same ids.
 * - Transfers resume from the target's `receivedBytes`. Appends go in order; one read runs
 *   ahead, so at most {@link PROJECT_COPY_MAX_CHUNKS_IN_MEMORY} chunks are held and at most two
 *   chunk calls per node are in flight (the cap is {@link PROJECT_COPY_MAX_CHUNK_RPCS_PER_NODE}).
 *   Chunks pass through as base64 and are never decoded or stored.
 * - A lost lease or connection pauses the copy (phase `acquire`) until the node is acquired
 *   again; the copy then resumes with the same ids through the node's current API (A22).
 * - `importStart` is a mutation: after a call that may have gone out, the node is asked whether
 *   it knows the import (by its id) before the same id and input are sent again (A3). Until it
 *   answered, a cancel goes through the import rather than around it.
 * - Once the target accepted the import it runs there on its own (`canCloseClient`). Following
 *   it outlives the subscription's connection: when that is replaced, the import is looked up
 *   by its id and followed again through the node's current one.
 * - A relayed node never carries more than its cap, bytes sent again included (A7).
 *
 * @module projectCopy/run
 */
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { ProjectId as ProjectIdSchema } from "@ryco/contracts/base-schemas";
import {
  PROJECT_COPY_CHUNK_BYTES,
  PROJECT_COPY_MAX_ARTIFACT_BYTES,
  PROJECT_COPY_MAX_AVATAR_BYTES,
  PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES,
  PROJECT_IMPORT_TERMINAL_STATUSES,
  ProjectExportId,
  ProjectImportId,
  ProjectTransferId,
  type ProjectExportArtifact,
  type ProjectExportArtifactKind,
  type ProjectExportResult,
  type ProjectImportErrorCode,
  type ProjectImportSnapshot,
  type ProjectImportStartInput,
  type ProjectTransferPurpose,
} from "@ryco/contracts/project-copy";

import {
  isProjectCopyLeaseLostError,
  isProjectCopyNodeUnavailableError,
  isProjectCopyRpcError,
  ProjectCopyNodeUnavailableError,
  type ProjectCopyIo,
  type ProjectCopyNodeApi,
  type ProjectCopyNodeHandle,
  type ProjectCopyNodePurpose,
} from "./io.ts";
import {
  createProjectCopyJobRecord,
  projectCopyJobTransfer,
  reduceProjectCopyJobRecord,
  type ProjectCopyJobChange,
  type ProjectCopyJobRecord,
} from "./jobRecord.ts";
import {
  buildProjectImportStartInput,
  formatCopyMegabytes,
  joinNodePath,
  projectCopyExportInclude,
  projectCopyTransferKinds,
  relayTooLargeMessage,
  type ProjectCopyRunPlan,
} from "./plan.ts";

/** Chunks held at once: one being appended, one read ahead (A22). */
export const PROJECT_COPY_MAX_CHUNKS_IN_MEMORY = 2;
/** Chunk calls in flight per node (A7); the memory bound keeps the copy at two. */
export const PROJECT_COPY_MAX_CHUNK_RPCS_PER_NODE = 4;

const TRANSIENT_ATTEMPTS = 5;
const REACQUIRE_ATTEMPTS = 3;
const IMPORT_START_ATTEMPTS = 6;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;
const FOLLOW_MAX_DELAY_MS = 30_000;
/** How long looking an import up by its id may wait for the node's answer before it asks again. */
export const PROJECT_COPY_IMPORT_LOOKUP_TIMEOUT_MS = 30_000;

export type ProjectCopyPhase =
  | "acquire"
  | "export"
  | "upload"
  | "import"
  | "done"
  | "failed"
  | "cancelled";

/** How a failed copy can go on: send the files instead of cloning, or resume where it stopped. */
export type ProjectCopyRetry = "send-files" | "resume";

export type ProjectCopyFailureCode =
  | ProjectImportErrorCode
  /** A node does not implement project copy. */
  | "unsupported"
  /** A node could not be reached or retained. */
  | "node-unavailable"
  /** Over the relay cap (A7) or the per-artifact limit. */
  | "too-large"
  | "export-failed"
  | "transfer-failed"
  /** The target refused `projects.importStart`. */
  | "import-rejected"
  /** The target no longer knows an import it accepted. */
  | "import-lost"
  /** The app closed during the upload and the copy's plan is gone. */
  | "upload-interrupted";

export interface ProjectCopyProgressError {
  readonly code: ProjectCopyFailureCode;
  readonly message: string;
  readonly retry: ProjectCopyRetry | null;
}

/** What the copy dialog, the progress toast and the Agent Control executor render (A36(2)). */
export interface ProjectCopyProgress {
  readonly copyId: string;
  /** `acquire` also while the copy waits to reconnect to a node. */
  readonly phase: ProjectCopyPhase;
  readonly uploadedBytes: number;
  readonly totalBytes: number;
  readonly importSnapshot: ProjectImportSnapshot | null;
  /** The target accepted the import, which now runs without this client. */
  readonly canCloseClient: boolean;
  readonly error: ProjectCopyProgressError | null;
}

export interface ProjectCopyCompletedProject {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /**
   * The project root on the target; null when a resumed copy no longer knows the repository's
   * subfolder (look the project up on the target by id).
   */
  readonly workspaceRoot: string | null;
  /** The coordinator's and the import's warnings. */
  readonly warnings: ReadonlyArray<string>;
}

export interface ProjectCopyOutcome {
  readonly progress: ProjectCopyProgress;
  readonly record: ProjectCopyJobRecord;
  /** Set when the import completed. */
  readonly project: ProjectCopyCompletedProject | null;
}

export interface ProjectCopyRun {
  readonly copyId: string;
  readonly getProgress: () => ProjectCopyProgress;
  /** Settles when the copy ends or is detached; never rejects. */
  readonly done: Promise<ProjectCopyOutcome>;
  /**
   * Before the import started, stops and cleans up. After, asks the target to cancel the import
   * and follows it until it ends.
   */
  readonly cancel: () => void;
  /**
   * Stops following once the import runs on its own (immediately when it already does);
   * `done` then settles with the progress so far and the record stays unfinished.
   */
  readonly detach: () => void;
}

export interface StartProjectCopyInput {
  readonly io: ProjectCopyIo;
  /**
   * The id of a new copy, when the app claimed it before the first record is published (so no
   * other window resumes a copy this one is starting); minted here otherwise. Ignored with
   * `resume` and `restartOf`, which keep theirs.
   */
  readonly copyId?: string | undefined;
  /**
   * What to copy. Null resumes `resume` without its plan: the copy can then only follow an
   * import that already started, and otherwise cleans up.
   */
  readonly plan: ProjectCopyRunPlan | null;
  /** An unfinished record to resume with its ids (after a reload, or a `resume` retry). */
  readonly resume?: ProjectCopyJobRecord | null | undefined;
  /** A finished record to start over with a new export and import (the `send-files` retry). */
  readonly restartOf?: ProjectCopyJobRecord | null | undefined;
  readonly agentControl?: ProjectCopyJobRecord["agentControl"] | undefined;
  readonly onProgress?: ((progress: ProjectCopyProgress) => void) | undefined;
  /** Every change of the job record, for the app to persist. */
  readonly onRecord?: ((record: ProjectCopyJobRecord) => void) | undefined;
}

class CopyFailure extends Error {
  readonly code: ProjectCopyFailureCode;
  readonly retry: ProjectCopyRetry | null;

  constructor(code: ProjectCopyFailureCode, message: string, retry: ProjectCopyRetry | null) {
    super(message);
    this.code = code;
    this.retry = retry;
  }
}

class CopyCancelled extends Error {}
class CopyDetached extends Error {}
/** The source no longer has the export (expired after a long pause). */
class ExportGone extends Error {}
/**
 * A node refused an artifact holding opted-in ignored files: its channel is not encrypted (a relay
 * the Hub can read, or plain http from another computer; A33). The copy goes on without them, as a
 * source on such a channel leaves them out.
 */
class IgnoredFilesRefused extends Error {
  readonly nodeLabel: string;

  constructor(nodeLabel: string) {
    super(`${nodeLabel} refused the ignored files over an unencrypted connection.`);
    this.nodeLabel = nodeLabel;
  }
}

/** The node's answer to bytes of `artifact` that it refuses for the channel they cross (A33). */
const refusesIgnoredFiles = (error: unknown, artifact: ProjectExportArtifact): boolean =>
  artifact.carriesIgnoredFiles === true &&
  isProjectCopyRpcError(error) &&
  error.code === "access-denied";

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;

const retryDelay = (attempt: number, max = RETRY_MAX_DELAY_MS): number =>
  Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), max);

/** Raw bytes of a base64 string; -1 when it is not padded base64. */
function base64ByteLength(value: string): number {
  if (value.length % 4 !== 0) return -1;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

const isTerminalImport = (snapshot: ProjectImportSnapshot): boolean =>
  PROJECT_IMPORT_TERMINAL_STATUSES.includes(snapshot.status);

function need<T>(member: T | undefined, label: string): T {
  if (member === undefined) {
    throw new CopyFailure("unsupported", `Update Ryco on ${label} to copy projects.`, null);
  }
  return member;
}

function initialRecord(input: StartProjectCopyInput): ProjectCopyJobRecord {
  const { io, plan } = input;
  if (input.resume) return input.resume;
  if (input.restartOf) {
    return reduceProjectCopyJobRecord(input.restartOf, {
      type: "restarted",
      at: io.now(),
      importId: ProjectImportId.make(io.uuid()),
      projectId: ProjectIdSchema.make(io.uuid()),
    });
  }
  if (plan === null) throw new Error("A project copy needs a plan or a record to resume.");
  return createProjectCopyJobRecord({
    copyId: input.copyId ?? io.uuid(),
    at: io.now(),
    sourceEnvironmentId: plan.source.kind === "export" ? plan.source.environmentId : null,
    sourceProjectId: plan.source.kind === "export" ? plan.source.projectId : null,
    targetEnvironmentId: plan.target.environmentId,
    projectId: ProjectIdSchema.make(io.uuid()),
    importId: ProjectImportId.make(io.uuid()),
    agentControl: input.agentControl ?? null,
  });
}

export function startProjectCopy(input: StartProjectCopyInput): ProjectCopyRun {
  const { io, plan } = input;
  let record = initialRecord(input);
  const { copyId, sourceEnvironmentId, targetEnvironmentId } = record;
  const source = plan?.source.kind === "export" ? plan.source : null;
  const targetLabel = plan?.target.label ?? "the destination";
  const sourceLabel = source?.label ?? "the source";
  const labelOf = (environmentId: EnvironmentId) =>
    environmentId === targetEnvironmentId ? targetLabel : sourceLabel;

  let progress: ProjectCopyProgress = {
    copyId,
    phase: "acquire",
    uploadedBytes: 0,
    totalBytes: 0,
    importSnapshot: null,
    canCloseClient: record.stage === "importing",
    error: null,
  };
  const warnings: string[] = [];
  let exportResult: ProjectExportResult | null = null;
  /** A node refused the opted-in ignored files (A33): export without them from then on. */
  let leaveOutIgnoredFiles = false;
  const uploadedByPurpose = new Map<ProjectTransferPurpose, number>();

  // Cancelling stops the work before the import; detaching (once the import runs on its own)
  // and finishing stop following it.
  const cancelController = new AbortController();
  const stopController = new AbortController();
  let cancelRequested = false;
  let cancelImportRequested = false;
  let detachRequested = false;
  let settled = false;
  /** Wakes the subscription `follow` waits on: the copy was detached, or the import ended. */
  const followWakers = new Set<(reason: "terminal" | "detached") => void>();
  const importAccepted = () => record.stage === "importing";
  /**
   * `projects.importStart` may have reached the target without its answer reaching this client
   * (a resumed record that stopped there, too). Until the target is asked by the import's id,
   * a cancel can't just stop: the import may run there and has to be cancelled through its id.
   */
  let importMayExist = record.stage === "import-requested";
  /** The import is (or may be) the target's now: a cancel goes through it, not around it. */
  const importOutstanding = () => importAccepted() || importMayExist;
  // Work before the import stops on cancel; settling the import and following it only on stop.
  const signalFor = () => (importOutstanding() ? stopController.signal : cancelController.signal);

  const emit = (patch: Partial<ProjectCopyProgress>) => {
    progress = { ...progress, ...patch };
    try {
      input.onProgress?.(progress);
    } catch {
      // A listener's failure must not stop the copy.
    }
  };
  const publishRecord = () => {
    try {
      input.onRecord?.(record);
    } catch {
      // Persisting is the app's concern; the copy goes on.
    }
  };
  const dispatch = (change: ProjectCopyJobChange) => {
    record = reduceProjectCopyJobRecord(record, { ...change, at: io.now() });
    publishRecord();
  };
  const stopFollowing = () => {
    stopController.abort();
    for (const wake of Array.from(followWakers)) wake("detached");
  };

  /** A cancel stops the copy only while no import of it can exist on the target yet. */
  const throwIfStopped = () => {
    if (stopController.signal.aborted) throw new CopyDetached();
    if (cancelRequested && !importOutstanding()) throw new CopyCancelled();
  };

  // ── Nodes ──

  const handles = new Map<EnvironmentId, ProjectCopyNodeHandle>();
  const purposes = new Map<EnvironmentId, ProjectCopyNodePurpose>();
  const reacquiring = new Map<EnvironmentId, Promise<void>>();
  let pausedNodes = 0;
  let phaseBeforePause: ProjectCopyPhase = "acquire";

  const releaseNode = (environmentId: EnvironmentId) => {
    handles.get(environmentId)?.release();
    handles.delete(environmentId);
  };
  const relayed = () => Array.from(handles.values()).some((handle) => handle.transport === "relay");
  /** A7: a relayed node never carries more than the cap, even after a reconnect. */
  const checkRelayBudget = () => {
    if (
      !importAccepted() &&
      relayed() &&
      progress.totalBytes > PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES
    ) {
      throw new CopyFailure("too-large", relayTooLargeMessage(progress.totalBytes), null);
    }
  };
  /** Nodes this copy reached through the Hub; their channel carries what is counted below. */
  const relayedNodes = new Set<EnvironmentId>();
  /** Raw artifact bytes this copy moved through each relayed node, re-sends included. */
  const relayedBytes = new Map<EnvironmentId, number>();
  /**
   * A7: the Hub's channel budget counts every byte sent through it, also the ones sent again
   * after an export was made anew or a transfer started over. Spent before a chunk goes out, so
   * a node's total never passes the cap.
   */
  const spendRelayBudget = (environmentId: EnvironmentId, bytes: number) => {
    if (!relayedNodes.has(environmentId)) return;
    const spent = (relayedBytes.get(environmentId) ?? 0) + bytes;
    if (spent > PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES) {
      throw new CopyFailure("too-large", relayTooLargeMessage(spent), null);
    }
    relayedBytes.set(environmentId, spent);
  };

  const acquire = async (environmentId: EnvironmentId, purpose: ProjectCopyNodePurpose) => {
    throwIfStopped();
    let handle: ProjectCopyNodeHandle;
    try {
      handle = await io.acquireNode({ environmentId, copyId, purpose, signal: signalFor() });
    } catch (error) {
      throwIfStopped();
      throw new CopyFailure(
        "node-unavailable",
        errorMessage(error, `Can't reach ${labelOf(environmentId)}.`),
        "resume",
      );
    }
    try {
      throwIfStopped();
    } catch (error) {
      handle.release();
      throw error;
    }
    releaseNode(environmentId);
    handles.set(environmentId, handle);
    purposes.set(environmentId, purpose);
    if (handle.transport === "relay") relayedNodes.add(environmentId);
    checkRelayBudget();
  };

  /** Pauses on a lost lease or connection until the node is acquired again (single-flight). */
  const reacquire = (environmentId: EnvironmentId): Promise<void> => {
    const running = reacquiring.get(environmentId);
    if (running) return running;
    if (pausedNodes++ === 0) {
      phaseBeforePause = progress.phase;
      emit({ phase: "acquire" });
    }
    const attempt = (async () => {
      try {
        releaseNode(environmentId);
        await acquire(environmentId, purposes.get(environmentId) ?? "copy");
      } finally {
        reacquiring.delete(environmentId);
        if (--pausedNodes === 0 && progress.phase === "acquire") emit({ phase: phaseBeforePause });
      }
    })();
    reacquiring.set(environmentId, attempt);
    return attempt;
  };

  /**
   * One idempotent call: retried after transient failures and after a reacquire. A node's
   * `ProjectCopyError` is a definite answer and is thrown as it is. A read gets the signal that
   * its connection went (see {@link ProjectCopyIo.withNode}).
   */
  const callNode = async <T>(
    environmentId: EnvironmentId,
    access: "lease" | "read",
    call: (api: ProjectCopyNodeApi, connectionLost?: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    let failures = 0;
    let reacquires = 0;
    for (;;) {
      throwIfStopped();
      try {
        return await (access === "lease"
          ? io.withLease(environmentId, call)
          : io.withNode(environmentId, call));
      } catch (error) {
        if (error instanceof CopyFailure || isProjectCopyRpcError(error)) throw error;
        throwIfStopped();
        if (isProjectCopyLeaseLostError(error) || isProjectCopyNodeUnavailableError(error)) {
          if (++reacquires > REACQUIRE_ATTEMPTS) {
            throw new CopyFailure(
              "node-unavailable",
              `Lost the connection to ${labelOf(environmentId)}.`,
              "resume",
            );
          }
          await reacquire(environmentId);
          continue;
        }
        if (++failures >= TRANSIENT_ATTEMPTS) {
          throw new CopyFailure(
            "node-unavailable",
            `${labelOf(environmentId)} did not answer.`,
            "resume",
          );
        }
        await io.sleep(retryDelay(failures), signalFor());
      }
    }
  };

  // ── Export ──

  const runExport = async (): Promise<ProjectExportResult> => {
    if (source === null || plan === null) throw new Error("No source to export from.");
    emit({ phase: "export" });
    const planned = projectCopyExportInclude(plan);
    if (planned === null) throw new Error("No source to export from.");
    const include = leaveOutIgnoredFiles ? { ...planned, ignoredPaths: [] } : planned;
    for (let attempt = 0; ; attempt += 1) {
      let exportId = record.exportId;
      if (exportId === null) {
        exportId = ProjectExportId.make(io.uuid());
        dispatch({ type: "export-assigned", exportId });
      }
      const exportInput = {
        exportId,
        projectId: source.projectId,
        include,
        ...(source.checkoutPath === null ? {} : { checkoutPath: source.checkoutPath }),
        // A relayed copy can't carry a bigger patch anyway (A7): let the source skip it.
        ...(relayed() ? { patchLimitBytes: PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES } : {}),
      };
      try {
        const result = await callNode(source.environmentId, "lease", (api) =>
          need(api.projects.exportStart, source.label)(exportInput),
        );
        return result;
      } catch (error) {
        // The same id with another input: a resumed copy whose choices changed. Start afresh.
        if (isProjectCopyRpcError(error) && error.code === "conflict" && attempt === 0) {
          dispatch({ type: "export-assigned", exportId: ProjectExportId.make(io.uuid()) });
          continue;
        }
        if (isProjectCopyRpcError(error)) {
          throw new CopyFailure("export-failed", error.message, null);
        }
        throw error;
      }
    }
  };

  /** The artifacts to send, after the export's skipped entries became warnings or failures. */
  const artifactsToSend = (result: ProjectExportResult): ReadonlyArray<ProjectExportArtifact> => {
    if (plan === null) return [];
    if (!result.repository.isGitRepository) {
      throw new CopyFailure(
        "export-failed",
        "The source is not a git repository. Copying plain folders is not supported yet.",
        null,
      );
    }
    const wanted = projectCopyTransferKinds(plan);
    for (const skipped of result.skipped) {
      if (!wanted.has(skipped.kind)) continue;
      if (skipped.kind === "repository-bundle") {
        throw new CopyFailure("export-failed", `The files can't be sent: ${skipped.reason}.`, null);
      }
      if (skipped.kind === "commits-bundle" && skipped.reason === "nothing unpushed") continue;
      warnings.push(SKIPPED_WARNINGS[skipped.kind](skipped.reason));
    }
    const artifacts: ProjectExportArtifact[] = [];
    for (const kind of ARTIFACT_ORDER) {
      if (!wanted.has(kind)) continue;
      const artifact = result.artifacts.find((entry) => entry.kind === kind);
      if (artifact === undefined || artifact.byteLength === 0) {
        if (kind === "repository-bundle") {
          throw new CopyFailure(
            "export-failed",
            "The source did not make the files to send.",
            null,
          );
        }
        continue;
      }
      if (kind === "avatar" && artifact.byteLength > PROJECT_COPY_MAX_AVATAR_BYTES) {
        warnings.push("The avatar was not copied: it is too large.");
        continue;
      }
      if (artifact.byteLength > PROJECT_COPY_MAX_ARTIFACT_BYTES) {
        throw new CopyFailure(
          "too-large",
          `Too large to copy (${formatCopyMegabytes(artifact.byteLength)}).`,
          null,
        );
      }
      artifacts.push(artifact);
    }
    return artifacts;
  };

  // ── Upload ──

  const setUploaded = (purpose: ProjectTransferPurpose, bytes: number) => {
    uploadedByPurpose.set(purpose, bytes);
    let total = 0;
    for (const value of uploadedByPurpose.values()) total += value;
    emit({ uploadedBytes: Math.min(total, progress.totalBytes) });
  };

  type ChunkRead =
    | { readonly ok: true; readonly offset: number; readonly length: number; readonly data: string }
    | { readonly ok: false; readonly error: unknown };

  const readChunk = (
    result: ProjectExportResult,
    artifact: ProjectExportArtifact,
    offset: number,
    length: number,
  ): Promise<ChunkRead> =>
    callNode(source!.environmentId, "read", (api) =>
      need(
        api.projects.exportReadChunk,
        sourceLabel,
      )({
        exportId: result.exportId,
        artifactId: artifact.artifactId,
        offset,
        length,
      }),
    ).then(
      (chunk): ChunkRead =>
        chunk.offset === offset &&
        chunk.length === length &&
        base64ByteLength(chunk.dataBase64) === length
          ? { ok: true, offset, length, data: chunk.dataBase64 }
          : {
              ok: false,
              error: new CopyFailure(
                "transfer-failed",
                `${sourceLabel} sent an unexpected chunk.`,
                "resume",
              ),
            },
      (error: unknown): ChunkRead => ({ ok: false, error }),
    );

  /**
   * Sends the artifact from `start` on. `rebegin` asks the caller to ask the target where it
   * stands (a gap, an expired transfer, or an unexpected `receivedBytes`).
   */
  const pumpChunks = async (
    result: ProjectExportResult,
    artifact: ProjectExportArtifact,
    transferId: ProjectTransferId,
    start: number,
  ): Promise<"done" | "rebegin"> => {
    const reads: Array<Promise<ChunkRead>> = [];
    let nextRead = start;
    let offset = start;
    // `appending` counts the chunk being appended, so reads + held chunks stay within the cap.
    const readAhead = (appending: boolean) => {
      while (
        reads.length + (appending ? 1 : 0) < PROJECT_COPY_MAX_CHUNKS_IN_MEMORY &&
        nextRead < artifact.byteLength
      ) {
        const length = Math.min(PROJECT_COPY_CHUNK_BYTES, artifact.byteLength - nextRead);
        spendRelayBudget(source!.environmentId, length);
        reads.push(readChunk(result, artifact, nextRead, length));
        nextRead += length;
      }
    };
    try {
      while (offset < artifact.byteLength) {
        readAhead(false);
        const read = await reads.shift()!;
        if (!read.ok) {
          const { error } = read;
          if (
            isProjectCopyRpcError(error) &&
            (error.code === "not-found" || error.code === "expired")
          ) {
            throw new ExportGone();
          }
          if (refusesIgnoredFiles(error, artifact)) throw new IgnoredFilesRefused(sourceLabel);
          throw error;
        }
        readAhead(true);
        spendRelayBudget(targetEnvironmentId, read.length);
        const appended = await callNode(targetEnvironmentId, "lease", (api) =>
          need(
            api.projects.transferAppend,
            targetLabel,
          )({
            transferId,
            offset: read.offset,
            dataBase64: read.data,
          }),
        );
        offset = read.offset + read.length;
        if (appended.receivedBytes !== offset) return "rebegin";
        setUploaded(artifact.kind, offset);
      }
      return "done";
    } catch (error) {
      // A refused read became `IgnoredFilesRefused` above: this is the target refusing a chunk.
      if (refusesIgnoredFiles(error, artifact)) throw new IgnoredFilesRefused(targetLabel);
      if (
        isProjectCopyRpcError(error) &&
        (error.receivedBytes !== undefined ||
          error.code === "not-found" ||
          error.code === "expired")
      ) {
        return "rebegin";
      }
      throw error;
    } finally {
      // Reads never reject; wait for the ones in flight so none outlives this attempt.
      await Promise.all(reads);
    }
  };

  /** Sends one artifact; resolves with the transfer it was committed under. */
  const uploadArtifact = async (
    result: ProjectExportResult,
    artifact: ProjectExportArtifact,
  ): Promise<ProjectTransferId> => {
    const purpose = artifact.kind;
    let transferId = projectCopyJobTransfer(record, purpose)?.transferId ?? null;
    const assignTransfer = () => {
      transferId = ProjectTransferId.make(io.uuid());
      dispatch({ type: "transfer-assigned", purpose, transferId });
      return transferId;
    };
    let fresh = 0;
    for (let rounds = 0; ; rounds += 1) {
      if (rounds > 20) {
        throw new CopyFailure(
          "transfer-failed",
          `The upload to ${targetLabel} keeps stalling.`,
          "resume",
        );
      }
      const id = transferId ?? assignTransfer();
      let receivedBytes: number;
      try {
        receivedBytes = (
          await callNode(targetEnvironmentId, "lease", (api) =>
            need(
              api.projects.transferBegin,
              targetLabel,
            )({
              transferId: id,
              purpose,
              byteLength: artifact.byteLength,
              sha256: artifact.sha256,
              ...(artifact.carriesIgnoredFiles === true ? { carriesIgnoredFiles: true } : {}),
            }),
          )
        ).receivedBytes;
      } catch (error) {
        if (refusesIgnoredFiles(error, artifact)) throw new IgnoredFilesRefused(targetLabel);
        // A transfer begun for other bytes (the export was made again): start a new one.
        if (isProjectCopyRpcError(error) && error.code === "conflict" && fresh++ < 2) {
          assignTransfer();
          continue;
        }
        if (isProjectCopyRpcError(error)) {
          throw new CopyFailure("transfer-failed", error.message, null);
        }
        throw error;
      }
      setUploaded(purpose, receivedBytes);
      if (receivedBytes < artifact.byteLength) {
        if ((await pumpChunks(result, artifact, id, receivedBytes)) === "rebegin") continue;
      }
      try {
        await callNode(targetEnvironmentId, "lease", (api) =>
          need(api.projects.transferCommit, targetLabel)({ transferId: id }),
        );
      } catch (error) {
        if (
          isProjectCopyRpcError(error) &&
          (error.code === "not-found" || error.code === "expired")
        ) {
          continue;
        }
        // The bytes did not verify: send them again under a new id.
        if (
          isProjectCopyRpcError(error) &&
          (error.code === "conflict" || error.code === "invalid") &&
          fresh++ < 2
        ) {
          assignTransfer();
          continue;
        }
        if (isProjectCopyRpcError(error)) {
          throw new CopyFailure("transfer-failed", error.message, null);
        }
        throw error;
      }
      setUploaded(purpose, artifact.byteLength);
      dispatch({ type: "transfer-committed", transferId: id });
      return id;
    }
  };

  /** Best effort: a transfer the target still holds expires there on its own. */
  const abortTransfer = async (transferId: ProjectTransferId) => {
    try {
      await io.withLease(targetEnvironmentId, (api) =>
        need(api.projects.transferAbort, targetLabel)({ transferId }),
      );
    } catch {
      // Transfers expire on their own.
    }
  };

  /**
   * Transfers sent for an earlier export of this copy whose artifact the current export does
   * not send (the source restarted and the changes were discarded meanwhile, say). The import
   * must never carry them with the new export's commit, so they leave the record and the target.
   */
  const dropStaleTransfers = async (artifacts: ReadonlyArray<ProjectExportArtifact>) => {
    const sent = new Set<ProjectTransferPurpose>(artifacts.map((artifact) => artifact.kind));
    for (const transfer of record.transfers) {
      if (sent.has(transfer.purpose)) continue;
      dispatch({ type: "transfer-dropped", transferId: transfer.transferId });
      await abortTransfer(transfer.transferId);
    }
  };

  /**
   * Export, then upload every artifact. An export that expired mid-way is made once more; one
   * whose ignored files a node refused (A33) is made again without them, and disposed at once.
   * Resolves with the export and the transfers its own artifacts were committed under.
   */
  const exportAndUpload = async (): Promise<{
    readonly result: ProjectExportResult;
    readonly transfers: Partial<Record<ProjectExportArtifactKind, ProjectTransferId>>;
  } | null> => {
    if (source === null) return null;
    let remadeAfterExpiry = false;
    for (;;) {
      const result = await runExport();
      exportResult = result;
      const warningCount = warnings.length;
      const artifacts = artifactsToSend(result);
      await dropStaleTransfers(artifacts);
      uploadedByPurpose.clear();
      emit({
        phase: "upload",
        uploadedBytes: 0,
        totalBytes: artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0),
      });
      checkRelayBudget();
      try {
        const transfers: Partial<Record<ProjectExportArtifactKind, ProjectTransferId>> = {};
        for (const artifact of artifacts) {
          transfers[artifact.kind] = await uploadArtifact(result, artifact);
        }
        return { result, transfers };
      } catch (error) {
        if (error instanceof IgnoredFilesRefused && !leaveOutIgnoredFiles) {
          leaveOutIgnoredFiles = true;
          warnings.length = warningCount;
          warnings.push(ignoredFilesLeftOutWarning(error.nodeLabel));
          // It holds the ignored files: gone now rather than when it expires.
          await disposeExport();
        } else if (error instanceof ExportGone && !remadeAfterExpiry) {
          remadeAfterExpiry = true;
          warnings.length = warningCount;
        } else if (error instanceof ExportGone) {
          throw new CopyFailure("export-failed", `The export on ${sourceLabel} expired.`, "resume");
        } else if (error instanceof IgnoredFilesRefused) {
          throw new CopyFailure("transfer-failed", error.message, null);
        } else {
          throw error;
        }
        dispatch({ type: "export-assigned", exportId: ProjectExportId.make(io.uuid()) });
      }
    }
  };

  // ── Import ──

  /**
   * One look at this copy's import by its id (A3), however many imports the target got since:
   * the first snapshot of `subscribeImport` is the current one. Null only when the target answers
   * that it does not know the import; any other end of the stream is no answer, so the caller
   * asks again.
   */
  const lookUpImport = (
    api: ProjectCopyNodeApi,
    connectionLost: AbortSignal | undefined,
  ): Promise<ProjectImportSnapshot | null> => {
    const subscribe = need(api.projects.subscribeImport, targetLabel);
    return new Promise((resolve, reject) => {
      let done = false;
      let unknown = false;
      let unsubscribe: (() => void) | null = null;
      const timeout = new AbortController();
      const finish = (settle: () => void) => {
        if (done) return;
        done = true;
        timeout.abort();
        connectionLost?.removeEventListener("abort", onConnectionLost);
        unsubscribe?.();
        settle();
      };
      // The stream ends without a word with its connection: ask again on the next one.
      const onConnectionLost = () =>
        finish(() =>
          reject(
            new ProjectCopyNodeUnavailableError(
              targetEnvironmentId,
              `Reconnecting to ${targetLabel}.`,
            ),
          ),
        );
      const stop = subscribe(
        { importId: record.importId },
        (snapshot) => {
          if (snapshot.importId === record.importId) finish(() => resolve(snapshot));
        },
        {
          classifyFailure: (error) => {
            unknown = isProjectCopyRpcError(error) && error.code === "not-found";
            return "failed";
          },
          onError: () =>
            finish(() =>
              unknown
                ? resolve(null)
                : reject(new Error(`${targetLabel} could not look up the copy.`)),
            ),
        },
      );
      if (done) stop();
      else unsubscribe = stop;
      if (connectionLost?.aborted) onConnectionLost();
      else connectionLost?.addEventListener("abort", onConnectionLost, { once: true });
      void io
        .sleep(PROJECT_COPY_IMPORT_LOOKUP_TIMEOUT_MS, timeout.signal)
        .then(() => finish(() => reject(new Error(`${targetLabel} did not answer.`))));
    });
  };

  /** The target's snapshot of this copy's import; null when the target does not know it. */
  const findImport = (): Promise<ProjectImportSnapshot | null> =>
    callNode(targetEnvironmentId, "read", lookUpImport);

  /**
   * A3: after a call that may have gone out, the same id and input are sent again only when the
   * target does not know the import. A lost lease means the call never went out. A cancel while
   * the import may exist looks it up first: a known import is cancelled through its id.
   */
  const startImport = async (
    startInput: ProjectImportStartInput,
  ): Promise<ProjectImportSnapshot> => {
    emit({ phase: "import" });
    dispatch({ type: "import-requested" });
    for (let attempt = 1; ; attempt += 1) {
      if (importMayExist) {
        const known = await findImport();
        if (known !== null) return known;
        importMayExist = false;
      }
      throwIfStopped();
      try {
        return await io.withLease(targetEnvironmentId, (api) =>
          need(api.projects.importStart, targetLabel)(startInput),
        );
      } catch (error) {
        if (error instanceof CopyFailure) throw error;
        if (isProjectCopyRpcError(error)) {
          throw new CopyFailure("import-rejected", error.message, null);
        }
        const notSent = isProjectCopyLeaseLostError(error);
        if (!notSent) importMayExist = true;
        if (attempt >= IMPORT_START_ATTEMPTS) {
          throw new CopyFailure(
            "node-unavailable",
            `Could not start the copy on ${targetLabel}.`,
            "resume",
          );
        }
        if (notSent || isProjectCopyNodeUnavailableError(error)) {
          await reacquire(targetEnvironmentId);
        } else {
          await io.sleep(retryDelay(attempt), signalFor());
        }
      }
    }
  };

  /** Shows the newest snapshot; a terminal one wakes the follow that waits for it. */
  const applySnapshot = (snapshot: ProjectImportSnapshot) => {
    if (snapshot.importId !== record.importId) return;
    const current = progress.importSnapshot;
    if (current !== null && isTerminalImport(current)) return;
    if (current !== null && snapshot.updatedAt < current.updatedAt) return;
    emit({ importSnapshot: snapshot });
    if (isTerminalImport(snapshot)) {
      for (const wake of Array.from(followWakers)) wake("terminal");
    }
  };

  /** Asks the target to cancel the import; a request in flight is not sent twice. */
  const requestCancelImport = () => {
    if (cancelImportRequested) return;
    cancelImportRequested = true;
    void callNode(targetEnvironmentId, "lease", (api) =>
      need(api.projects.cancelImport, targetLabel)({ importId: record.importId }),
    ).then(applySnapshot, () => {
      // The import goes on: a later Cancel, or following it again, asks once more.
      cancelImportRequested = false;
    });
  };

  /**
   * Follows the import through one subscription until it ends, the copy is detached, or the
   * subscription stops: with an error, or silently because its connection went.
   */
  const subscribeOnce = (): Promise<"terminal" | "ended" | "detached"> =>
    new Promise((resolve) => {
      let unsubscribe: (() => void) | null = null;
      let connectionLost: AbortSignal | null = null;
      let done = false;
      const finish = (result: "terminal" | "ended" | "detached") => {
        if (done) return;
        done = true;
        followWakers.delete(finish);
        connectionLost?.removeEventListener("abort", onConnectionLost);
        unsubscribe?.();
        resolve(result);
      };
      const onConnectionLost = () => finish("ended");
      if (stopController.signal.aborted) {
        finish("detached");
        return;
      }
      if (progress.importSnapshot !== null && isTerminalImport(progress.importSnapshot)) {
        finish("terminal");
        return;
      }
      followWakers.add(finish);
      io.withNode(targetEnvironmentId, async (api, lost) => {
        if (done) return;
        // A terminal snapshot wakes this follow through `applySnapshot`.
        const stop = need(api.projects.subscribeImport, targetLabel)(
          { importId: record.importId },
          applySnapshot,
          { onError: () => finish("ended") },
        );
        if (done) {
          stop();
          return;
        }
        unsubscribe = stop;
        connectionLost = lost;
        if (lost.aborted) finish("ended");
        else lost.addEventListener("abort", onConnectionLost, { once: true });
      }).catch(() => finish("ended"));
    });

  /** Follows the import until it ends; null when detached. */
  const follow = async (): Promise<ProjectImportSnapshot | null> => {
    for (let quiet = 1; ; quiet += 1) {
      const ended = await subscribeOnce();
      if (ended === "detached") return null;
      if (ended === "terminal") return progress.importSnapshot;
      // The stream ended early or its connection went: ask the node where the import stands.
      try {
        const known = await findImport();
        if (known === null) {
          throw new CopyFailure("import-lost", `${targetLabel} no longer knows this copy.`, null);
        }
        applySnapshot(known);
        if (isTerminalImport(known)) return progress.importSnapshot;
        // A cancel that did not get through is asked for again now that the node answers.
        if (cancelRequested) requestCancelImport();
        quiet = 0;
      } catch (error) {
        if (error instanceof CopyDetached) return null;
        if (error instanceof CopyFailure && error.code === "import-lost") throw error;
        // Unreachable for now: the import runs on; keep trying at a slower pace.
      }
      await io.sleep(retryDelay(quiet, FOLLOW_MAX_DELAY_MS), stopController.signal);
      if (stopController.signal.aborted) return null;
    }
  };

  const disposeExport = async () => {
    const exportId = record.exportId;
    if (sourceEnvironmentId === null || exportId === null || !handles.has(sourceEnvironmentId)) {
      return;
    }
    try {
      await io.withLease(sourceEnvironmentId, (api) =>
        need(api.projects.exportDispose, sourceLabel)({ exportId }),
      );
    } catch {
      // The export expires on its own.
    }
  };

  /** Best effort, before any import exists: the target and source sweep what is left. */
  const cleanUpBeforeImport = async () => {
    if (handles.has(targetEnvironmentId)) {
      for (const transfer of record.transfers) await abortTransfer(transfer.transferId);
    }
    await disposeExport();
  };

  /**
   * The import runs on its own now: dispose the export, let go of the source, and keep only a
   * view of the target (A22).
   */
  const afterImportAccepted = async (snapshot: ProjectImportSnapshot) => {
    importMayExist = false;
    dispatch({ type: "import-accepted" });
    emit({ phase: "import", canCloseClient: true });
    applySnapshot(snapshot);
    if (cancelRequested) requestCancelImport();
    if (detachRequested) stopFollowing();
    await disposeExport();
    if (sourceEnvironmentId !== null && sourceEnvironmentId !== targetEnvironmentId) {
      releaseNode(sourceEnvironmentId);
    }
    if (purposes.get(targetEnvironmentId) === "follow") return;
    const copyHandle = handles.get(targetEnvironmentId);
    handles.delete(targetEnvironmentId);
    try {
      await acquire(targetEnvironmentId, "follow");
      copyHandle?.release();
    } catch (error) {
      // Following works through the copy scope too; keep it.
      if (copyHandle !== undefined) {
        if (handles.has(targetEnvironmentId)) copyHandle.release();
        else handles.set(targetEnvironmentId, copyHandle);
      }
      if (error instanceof CopyDetached) throw error;
    }
  };

  // ── The copy ──

  const finishFromImport = (snapshot: ProjectImportSnapshot | null) => {
    if (snapshot === null) return;
    switch (snapshot.status) {
      case "completed":
        dispatch({ type: "finished", outcome: "completed" });
        emit({ phase: "done", error: null });
        return;
      case "cancelled":
        dispatch({ type: "finished", outcome: "cancelled" });
        emit({ phase: "cancelled", error: null });
        return;
      case "failed":
      case "interrupted": {
        const code: ProjectCopyFailureCode =
          snapshot.error?.code ?? (snapshot.status === "interrupted" ? "interrupted" : "internal");
        dispatch({ type: "finished", outcome: "failed" });
        emit({
          phase: "failed",
          error: {
            code,
            message:
              snapshot.error?.message ??
              (snapshot.status === "interrupted"
                ? `${targetLabel} restarted during the copy.`
                : "The copy failed."),
            retry: code === "remote-unreachable" && plan?.sendFilesFallback ? "send-files" : null,
          },
        });
        return;
      }
      case "running":
        return;
    }
  };

  const runFollow = async () => {
    const terminal = await follow();
    finishFromImport(terminal);
  };

  const main = async (): Promise<void> => {
    if (record.stage === "finished") {
      emit({ phase: record.outcome === "completed" ? "done" : (record.outcome ?? "failed") });
      return;
    }
    // A reload: the import may already run on the target. Until the target answers by its id,
    // a cancel waits for that answer (`importMayExist`), so a running import is cancelled there.
    if (input.resume && (record.stage === "import-requested" || record.stage === "importing")) {
      const resend = record.stage === "import-requested" && plan !== null;
      await acquire(targetEnvironmentId, resend ? "copy" : "follow");
      const known = await findImport();
      if (known !== null) {
        await afterImportAccepted(known);
        return runFollow();
      }
      if (record.stage === "importing") {
        throw new CopyFailure("import-lost", `${targetLabel} no longer knows this copy.`, null);
      }
      // The target never got it: a cancel now stops the copy before anything is sent again.
      importMayExist = false;
      throwIfStopped();
    }
    if (plan === null) {
      // Without the plan an unfinished upload can't go on; the failure cleans up what it left.
      await Promise.allSettled([
        acquire(targetEnvironmentId, "copy"),
        ...(sourceEnvironmentId === null ? [] : [acquire(sourceEnvironmentId, "copy")]),
      ]);
      throw new CopyFailure(
        "upload-interrupted",
        "The copy stopped when Ryco closed during the upload. Start it again.",
        null,
      );
    }

    emit({ phase: "acquire" });
    // Settle both before failing, so a node acquired late is still released.
    const acquired = await Promise.allSettled([
      handles.has(targetEnvironmentId) ? undefined : acquire(targetEnvironmentId, "copy"),
      source === null ? undefined : acquire(source.environmentId, "copy"),
    ]);
    for (const result of acquired) {
      if (result.status === "rejected") throw result.reason;
    }
    const uploaded = await exportAndUpload();
    throwIfStopped();
    // Only this export's own transfers: one left from an earlier export never rides along.
    const built = buildProjectImportStartInput({
      plan,
      importId: record.importId,
      projectId: record.projectId,
      exportResult: uploaded?.result ?? null,
      transfers: uploaded?.transfers ?? {},
    });
    warnings.push(...built.warnings);
    const accepted = await startImport(built.input);
    await afterImportAccepted(accepted);
    return runFollow();
  };

  const settle = async (): Promise<ProjectCopyOutcome> => {
    try {
      await main();
    } catch (error) {
      if (error instanceof CopyDetached) {
        // Detached: the import (if any) runs on; the record stays unfinished.
      } else if (error instanceof CopyCancelled) {
        await cleanUpBeforeImport();
        dispatch({ type: "finished", outcome: "cancelled" });
        emit({ phase: "cancelled", error: null });
      } else {
        const failure =
          error instanceof CopyFailure
            ? error
            : new CopyFailure("internal", errorMessage(error, "The copy failed."), null);
        if (failure.retry === null && !importAccepted()) await cleanUpBeforeImport();
        // A resumable failure leaves the record unfinished, so the copy can pick it up again.
        if (failure.retry === null) {
          dispatch({ type: "finished", outcome: "failed" });
        }
        emit({
          phase: "failed",
          error: { code: failure.code, message: failure.message, retry: failure.retry },
        });
      }
    } finally {
      settled = true;
      stopController.abort();
      for (const environmentId of Array.from(handles.keys())) releaseNode(environmentId);
    }
    return { progress, record, project: completedProject() };
  };

  const completedProject = (): ProjectCopyCompletedProject | null => {
    const snapshot = progress.importSnapshot;
    if (progress.phase !== "done" || snapshot === null) return null;
    const relativeRoot =
      plan?.source.kind === "clone-only"
        ? plan.source.relativeRootInRepository
        : (exportResult?.settings.relativeRootInRepository ?? null);
    const segments = relativeRoot?.split("/").filter((segment) => segment.length > 0) ?? null;
    return {
      environmentId: targetEnvironmentId,
      projectId: snapshot.projectId,
      workspaceRoot:
        segments === null
          ? null
          : segments.length === 0
            ? snapshot.destinationPath
            : plan === null
              ? null
              : joinNodePath(snapshot.destinationPath, segments, plan.target.pathSeparator),
      warnings: [...warnings, ...snapshot.warnings],
    };
  };

  publishRecord();
  emit({});
  const done = settle();

  return {
    copyId,
    getProgress: () => progress,
    done,
    cancel: () => {
      if (settled) return;
      if (!cancelRequested) {
        cancelRequested = true;
        cancelController.abort();
      }
      // Pressed again after a request that did not get through: it is sent once more.
      if (importAccepted()) requestCancelImport();
    },
    detach: () => {
      if (settled || detachRequested) return;
      detachRequested = true;
      // Before the import is accepted the copy still needs this client; it detaches then.
      if (importAccepted()) stopFollowing();
    },
  };
}

const ARTIFACT_ORDER: ReadonlyArray<ProjectExportArtifactKind> = [
  "repository-bundle",
  "commits-bundle",
  "changes-patch",
  "avatar",
];

const ignoredFilesLeftOutWarning = (nodeLabel: string) =>
  `The ignored files were not copied: they are only sent over an encrypted connection, and the one to ${nodeLabel} is not.`;

const SKIPPED_WARNINGS: Record<ProjectExportArtifactKind, (reason: string) => string> = {
  "commits-bundle": (reason) => `Unpushed commits were not copied (${reason}).`,
  "repository-bundle": (reason) => `The files were not sent (${reason}).`,
  "changes-patch": (reason) => `Uncommitted changes were not copied (${reason}).`,
  avatar: (reason) => `The avatar was not copied (${reason}).`,
};
