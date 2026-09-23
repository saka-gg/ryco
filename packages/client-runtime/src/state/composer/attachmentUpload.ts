import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type EnvironmentId,
  type FileAttachmentCreateUploadUrlInput,
  type FileAttachmentCreateUploadUrlResult,
  type ExecutionEnvironmentCapabilities,
  type ThreadId,
} from "@ryco/contracts";

import type { ChatFileUploadReadiness } from "./attachmentUploadReadiness.ts";

// ---------------------------------------------------------------------------
// Upload state machine
// ---------------------------------------------------------------------------

export type ChatFileUploadStatus =
  | { readonly kind: "pending" }
  | { readonly kind: "uploading"; readonly progress: number }
  | { readonly kind: "uploaded"; readonly uploadToken: string; readonly expiresAt: string }
  | {
      readonly kind: "failed";
      readonly retryable: boolean;
      readonly message: string;
      readonly label?: string;
    }
  | { readonly kind: "needsReattach"; readonly message: string };

export interface ChatFileUploadRequest {
  readonly attachmentId: string;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Bytes are held transiently by the engine and never persisted. */
  readBytes: () => Uint8Array | Promise<Uint8Array>;
}

export interface ChatFileUploadRecord extends ChatFileUploadRequest {
  readonly status: ChatFileUploadStatus;
}

/** Port the platform adapter implements: token minting plus raw byte transfer. */
export interface ChatFileUploadTransport {
  createFileUploadUrl(
    input: FileAttachmentCreateUploadUrlInput & {
      readonly environmentId: EnvironmentId;
      readonly signal?: AbortSignal;
    },
  ): Promise<FileAttachmentCreateUploadUrlResult>;
  transferBytes(input: {
    readonly environmentId: EnvironmentId;
    readonly uploadToken: string;
    readonly signal?: AbortSignal;
    readonly bytes: Uint8Array;
    readonly onProgress?: (progress: number) => void;
  }): Promise<{ name?: string; mimeType?: string; sizeBytes?: number }>;
}

/** Buffer between a token expiring and a send reading it, in milliseconds. */
const UPLOAD_TOKEN_EXPIRY_MARGIN_MS = 30_000;

export function isFileUploadTokenUsable(expiresAt: string, nowMs: number): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }
  return nowMs < expiresAtMs - UPLOAD_TOKEN_EXPIRY_MARGIN_MS;
}

/**
 * Streaming-upload byte limit for non-image attachments. The capability
 * ceiling wins when present; without one the upload flow is unavailable and
 * callers fall back to the inline dataUrl path.
 */
export function resolveFileUploadMaxBytes(
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
): number | null {
  const maxUploadBytes = capabilities?.fileAttachments?.maxUploadBytes;
  if (
    typeof maxUploadBytes !== "number" ||
    !Number.isFinite(maxUploadBytes) ||
    maxUploadBytes <= 0
  ) {
    return null;
  }
  return Math.min(maxUploadBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
}

/** True while a send must be held back: pending, uploading, or failed. */
export function isChatFileUploadBlocking(status: ChatFileUploadStatus | undefined): boolean {
  if (status === undefined) {
    return false;
  }
  return status.kind === "pending" || status.kind === "uploading" || status.kind === "failed";
}

export interface ChatFileUploadEngine {
  get: (attachmentId: string) => ChatFileUploadRecord | null;
  snapshot: () => ReadonlyMap<string, ChatFileUploadRecord>;
  subscribe: (listener: () => void) => () => void;
  enqueue: (request: ChatFileUploadRequest) => void;
  retry: (attachmentId: string) => void;
  seedUploaded: (input: {
    attachmentId: string;
    threadId: ThreadId;
    environmentId: EnvironmentId;
    name: string;
    mimeType: string;
    sizeBytes: number;
    uploadToken: string;
    expiresAt: string;
  }) => void;
  seedNeedsReattach: (attachmentId: string) => void;
  /** Confirms the token is still fresh, otherwise demotes to needsReattach. */
  verifyUsable: (attachmentId: string, nowMs: number) => boolean;
  release: (attachmentId: string) => void;
  releaseAll: () => void;
}

export function createChatFileUploadEngine(
  transport: ChatFileUploadTransport,
  options?: {
    nowMs?: () => number;
    /** One automatic retry per new ready generation; no timers or failure-driven loops. */
    watchReadiness?: (
      environmentId: EnvironmentId,
      onChange: () => void,
    ) => ChatFileUploadReadiness | Promise<ChatFileUploadReadiness>;
  },
): ChatFileUploadEngine {
  const nowMs = options?.nowMs ?? (() => Date.now());
  const records = new Map<string, ChatFileUploadRecord>();
  const queue: string[] = [];
  interface Job {
    readiness: ChatFileUploadReadiness | null;
    initialized: boolean;
    generation: object | null;
    recovery: number;
    attemptedRecovery: number;
    cancelAttempt: (() => void) | null;
    reportUnavailable: ((message: string, label: string) => void) | null;
  }
  const jobs = new Map<string, Job>();
  let scheduled = false;

  function cancelJob(attachmentId: string, cancelActive = true): void {
    const job = jobs.get(attachmentId);
    jobs.delete(attachmentId);
    const index = queue.indexOf(attachmentId);
    if (index !== -1) queue.splice(index, 1);
    job?.readiness?.dispose();
    if (cancelActive) job?.cancelAttempt?.();
  }

  function refreshReadiness(job: Job): boolean {
    if (!options?.watchReadiness) return true;
    if (!job.initialized) return false;
    const generation = job.readiness?.read() ?? null;
    if (generation !== job.generation) {
      if (generation !== null) job.recovery += 1;
      job.generation = generation;
    }
    return generation !== null;
  }

  function showUnavailable(id: string, job: Job): void {
    if (!job.initialized) return;
    const record = records.get(id);
    if (!record || record.status.kind === "uploaded" || record.status.kind === "needsReattach")
      return;
    if (record.status.kind === "failed" && !record.status.retryable) return;
    const unavailable = job.readiness?.unavailable?.() ?? {
      label: "Reconnect",
      message: "Waiting for the environment to reconnect. Reconnect or remove this attachment.",
      cancelInFlight: false,
    };
    if (job.reportUnavailable) job.reportUnavailable(unavailable.message, unavailable.label);
    else if (
      record.status.kind !== "failed" ||
      record.status.message !== unavailable.message ||
      record.status.label !== unavailable.label
    ) {
      put({
        ...record,
        status: {
          kind: "failed",
          retryable: true,
          message: unavailable.message,
          label: unavailable.label,
        },
      });
    }
    const index = queue.indexOf(id);
    if (index !== -1) queue.splice(index, 1);
    if (unavailable.cancelInFlight) job.cancelAttempt?.();
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    void Promise.resolve().then(() => {
      scheduled = false;
      for (const [id, job] of jobs) {
        const ready = refreshReadiness(job);
        if (!ready) {
          showUnavailable(id, job);
          continue;
        }
        const record = records.get(id);
        if (job.cancelAttempt && record?.status.kind === "failed" && record.status.label) {
          job.reportUnavailable?.(
            "An interrupted upload is still settling. Retry it or remove this attachment.",
            "Interrupted",
          );
        }
        if (
          !job.cancelAttempt &&
          job.recovery > job.attemptedRecovery &&
          record?.status.kind === "failed" &&
          record.status.retryable
        ) {
          if (!queue.includes(id)) queue.push(id);
          put({ ...record, status: { kind: "pending" } });
        }
      }
      void pump();
    });
  }

  let inFlightCount = 0;
  const listeners = new Set<() => void>();
  let snapshotCache: ReadonlyMap<string, ChatFileUploadRecord> | null = null;

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function put(record: ChatFileUploadRecord): void {
    records.set(record.attachmentId, record);
    snapshotCache = null;
    if (record.status.kind === "uploaded" || record.status.kind === "needsReattach") {
      cancelJob(record.attachmentId, record.status.kind !== "uploaded");
    }
    notify();
  }

  function getSnapshot(): ReadonlyMap<string, ChatFileUploadRecord> {
    if (!snapshotCache) {
      snapshotCache = new Map(records);
    }
    return snapshotCache;
  }

  async function pump(): Promise<void> {
    if (inFlightCount > 0) {
      return;
    }
    const index = queue.findIndex((id) => {
      const job = jobs.get(id);
      return job !== undefined && refreshReadiness(job);
    });
    if (index === -1) return;
    const attachmentId = queue.splice(index, 1)[0]!;
    const record = records.get(attachmentId);
    const job = jobs.get(attachmentId);
    if (!record || !job || record.status.kind !== "pending") return;
    // Consume recovery only when work starts. A manual retry consumes the same
    // budget, and multiple recoveries while one request settles coalesce here.
    job.attemptedRecovery = job.recovery;
    const generation = job.generation;
    const controller = new AbortController();
    const assertReady = () => {
      if (controller.signal.aborted || !refreshReadiness(job) || job.generation !== generation) {
        throw new Error("The environment connection changed during the upload.");
      }
    };
    let activeRecord = record;
    const isCurrent = () => records.get(attachmentId) === activeRecord;
    const update = (next: ChatFileUploadRecord) => {
      if (!isCurrent()) return;
      activeRecord = next;
      put(next);
    };
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        controller.abort();
        reject(
          new Error(
            activeRecord.status.kind === "failed"
              ? activeRecord.status.message
              : "The upload was cancelled.",
          ),
        );
      };
    });
    // Cancellation can happen in a synchronous subscriber before the first await.
    void cancelled.catch(() => undefined);
    const waitForAttempt = <T>(work: Promise<T>): Promise<T> => Promise.race([work, cancelled]);
    job.cancelAttempt = cancel;
    job.reportUnavailable = (message, label) => {
      if (
        activeRecord.status.kind === "failed" &&
        activeRecord.status.message === message &&
        activeRecord.status.label === label
      )
        return;
      update({ ...activeRecord, status: { kind: "failed", retryable: true, message, label } });
    };
    inFlightCount += 1;
    try {
      update({ ...record, status: { kind: "uploading", progress: 0 } });
      let token: string;
      let expiresAt: string;
      try {
        if (!isCurrent()) return;
        assertReady();
        const minted = await waitForAttempt(
          transport.createFileUploadUrl({
            signal: controller.signal,
            environmentId: record.environmentId,
            threadId: record.threadId,
            name: record.name,
            mimeType: record.mimeType,
            sizeBytes: record.sizeBytes,
          }),
        );
        token = minted.uploadToken;
        expiresAt = minted.expiresAt;
      } catch (error) {
        update({
          ...record,
          status: {
            kind: "failed",
            retryable: true,
            message: error instanceof Error ? error.message : "Could not start the upload.",
          },
        });
        return;
      }
      try {
        if (!isCurrent()) return;
        assertReady();
        const bytes = await waitForAttempt(Promise.resolve(record.readBytes()));
        if (!isCurrent()) return;
        assertReady();
        const confirmed = await waitForAttempt(
          transport.transferBytes({
            signal: controller.signal,
            environmentId: record.environmentId,
            uploadToken: token,
            bytes,
            onProgress: (progress) => {
              const current = records.get(record.attachmentId);
              if (!isCurrent() || !current || current.status.kind !== "uploading") {
                return;
              }
              update({ ...current, status: { kind: "uploading", progress } });
            },
          }),
        );
        // A response can resolve just before cancellation wins the next microtask.
        if (controller.signal.aborted) return;
        const confirmedSizeBytes =
          confirmed.sizeBytes !== undefined &&
          Number.isFinite(confirmed.sizeBytes) &&
          confirmed.sizeBytes >= 0
            ? confirmed.sizeBytes
            : record.sizeBytes;
        update({
          ...record,
          sizeBytes: confirmedSizeBytes,
          status: {
            kind: "uploaded",
            uploadToken: token,
            expiresAt,
          },
        });
      } catch (error) {
        update({
          ...record,
          status: {
            kind: "failed",
            retryable: true,
            message: error instanceof Error ? error.message : "The upload failed.",
          },
        });
      }
    } finally {
      job.cancelAttempt = null;
      job.reportUnavailable = null;
      inFlightCount -= 1;
      schedule();
    }
  }

  return {
    get: (attachmentId) => records.get(attachmentId) ?? null,
    snapshot: () => getSnapshot(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enqueue: (request) => {
      cancelJob(request.attachmentId);
      const job: Job = {
        readiness: null,
        initialized: !options?.watchReadiness,
        generation: null,
        recovery: 0,
        attemptedRecovery: 0,
        cancelAttempt: null,
        reportUnavailable: null,
      };
      jobs.set(request.attachmentId, job);
      if (options?.watchReadiness) {
        // Read synchronously on notifications so even a fast disconnect/reconnect
        // cannot collapse into a single ready observation before the queued retry.
        const onChange = () => {
          if (jobs.get(request.attachmentId) !== job) return;
          if (!refreshReadiness(job)) showUnavailable(request.attachmentId, job);
          schedule();
        };
        void Promise.resolve(options.watchReadiness(request.environmentId, onChange)).then(
          (readiness) => {
            if (jobs.get(request.attachmentId) !== job) {
              readiness.dispose();
              return;
            }
            job.readiness = readiness;
            job.initialized = true;
            onChange();
          },
          () => {
            if (jobs.get(request.attachmentId) !== job) return;
            const record = records.get(request.attachmentId);
            if (record)
              put({
                ...record,
                status: { kind: "needsReattach", message: "The upload could not be initialized." },
              });
          },
        );
      }
      queue.push(request.attachmentId);
      put({ ...request, status: { kind: "pending" } });
      void pump();
      schedule();
    },
    retry: (attachmentId) => {
      const record = records.get(attachmentId);
      if (!record || record.status.kind !== "failed" || !record.status.retryable) {
        return;
      }
      jobs.get(attachmentId)?.cancelAttempt?.();
      if (!queue.includes(attachmentId)) {
        queue.push(attachmentId);
      }
      put({ ...record, status: { kind: "pending" } });
      void pump();
      schedule();
    },
    seedUploaded: (input) => {
      cancelJob(input.attachmentId);
      const record: ChatFileUploadRecord = {
        attachmentId: input.attachmentId,
        threadId: input.threadId,
        environmentId: input.environmentId,
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        readBytes: () => {
          throw new Error("Uploaded attachments do not keep local bytes.");
        },
        status: { kind: "uploaded", uploadToken: input.uploadToken, expiresAt: input.expiresAt },
      };
      if (!isFileUploadTokenUsable(input.expiresAt, nowMs())) {
        put({ ...record, status: { kind: "needsReattach", message: "The upload token expired." } });
        return;
      }
      put(record);
    },
    seedNeedsReattach: (attachmentId) => {
      const existing = records.get(attachmentId);
      if (existing?.status.kind === "uploaded") {
        return;
      }
      put({
        attachmentId,
        threadId: "" as ThreadId,
        environmentId: "" as EnvironmentId,
        name: existing?.name ?? "",
        mimeType: existing?.mimeType ?? "",
        sizeBytes: existing?.sizeBytes ?? 0,
        readBytes: () => {
          throw new Error("Unattached attachments do not keep local bytes.");
        },
        status: { kind: "needsReattach", message: "The upload did not finish." },
      });
    },
    verifyUsable: (attachmentId, checkMs) => {
      const record = records.get(attachmentId);
      if (!record || record.status.kind !== "uploaded") {
        return false;
      }
      if (isFileUploadTokenUsable(record.status.expiresAt, checkMs)) {
        return true;
      }
      put({
        ...record,
        status: { kind: "needsReattach", message: "The upload token expired." },
      });
      return false;
    },
    release: (attachmentId) => {
      cancelJob(attachmentId);
      if (!records.delete(attachmentId)) {
        return;
      }
      snapshotCache = null;
      notify();
    },
    releaseAll: () => {
      if (records.size === 0) {
        return;
      }
      for (const id of jobs.keys()) cancelJob(id);
      records.clear();
      queue.length = 0;
      snapshotCache = null;
      notify();
    },
  };
}

// ---------------------------------------------------------------------------
// Send-time derivation
// ---------------------------------------------------------------------------

/**
 * Send-block derivation for a composer attachment list. `blockReason` is
 * non-null while any attachment is still uploading, failed, or attached with
 * a token that has since expired.
 */
export function deriveChatFileUploadSendBlock(input: {
  readonly attachmentIds: ReadonlyArray<string>;
  readonly getRecord: (attachmentId: string) => ChatFileUploadRecord | null;
  readonly nowMs: number;
}): { readonly blockReason: string | null } {
  for (const attachmentId of input.attachmentIds) {
    const record = input.getRecord(attachmentId);
    if (!record) {
      continue;
    }
    if (isChatFileUploadBlocking(record.status)) {
      return {
        blockReason:
          record.status.kind === "failed"
            ? `'${record.name}' failed to upload. ${record.status.message} Retry it or remove it.`
            : `Uploading '${record.name}'…`,
      };
    }
    if (
      record.status.kind === "needsReattach" ||
      (record.status.kind === "uploaded" &&
        !isFileUploadTokenUsable(record.status.expiresAt, input.nowMs))
    ) {
      return { blockReason: `Attach '${record.name}' again to send this message.` };
    }
  }
  return { blockReason: null };
}
