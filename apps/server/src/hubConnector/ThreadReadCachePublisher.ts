import { Schema } from "effect";
import type { OrchestrationShellSnapshot, OrchestrationMessage, ThreadId } from "@ryco/contracts";
import { ThreadReadCacheContent } from "@ryco/contracts/thread-read-cache";

const MAX_BATCH_BYTES = 2 * 1024 * 1024 - 4096;
const MAX_THREAD_BYTES = 1024 * 1024;
const MAX_THREADS = 512;
/** Mirrors the filter of `ThreadReadCacheShell` (packages/contracts thread-read-cache). */
const THREAD_READ_CACHE_SHELL_LIMITS = { projects: 2_000, worktrees: 10_000, threads: 10_000 };
const REFRESH_MS = 24 * 60 * 60 * 1000;
export const THREAD_READ_CACHE_PUBLISH_INTERVAL_MS = 5_000;

export type ThreadReadCacheUpload =
  | {
      readonly kind: "shell";
      readonly revision: number;
      readonly snapshot: OrchestrationShellSnapshot;
    }
  | {
      readonly kind: "thread";
      readonly threadId: string;
      readonly revision: number;
      readonly snapshot: ThreadReadCacheContent;
    };

export interface ThreadReadCachePublisherDeps {
  /** Null while offline or when this process does not own the enrolled identity. */
  readonly nodeId: () => string | null;
  readonly now: () => number;
  readonly readSequence: () => Promise<number>;
  readonly readShell: () => Promise<OrchestrationShellSnapshot>;
  readonly readThread: (threadId: ThreadId) => Promise<{
    readonly revision: number;
    readonly messages: ReadonlyArray<OrchestrationMessage>;
  } | null>;
  readonly begin: () => Promise<number>;
  readonly upload: (
    generation: number,
    items: ReadonlyArray<ThreadReadCacheUpload>,
  ) => Promise<void>;
}

/**
 * The shell upload for one batch: the whole shell when it fits the batch
 * limit, otherwise the most recently updated threads that do, with every
 * project and worktree. A node with more threads than one batch holds (about
 * 1.6k) used to fail every upload — so its cloud history never published at
 * all — rather than show its most recent work. Returns the encoded size of the
 * one-item batch so it is not serialized a second time to be measured.
 */
export function boundThreadReadCacheShell(
  shell: OrchestrationShellSnapshot,
  maxBatchBytes: number = MAX_BATCH_BYTES,
): { readonly snapshot: OrchestrationShellSnapshot; readonly batchBytes: number } {
  const batchBytes = (snapshot: OrchestrationShellSnapshot) =>
    Buffer.byteLength(
      JSON.stringify([{ kind: "shell", revision: shell.snapshotSequence, snapshot }]),
      "utf8",
    );
  const whole = batchBytes(shell);
  if (whole <= maxBatchBytes) return { snapshot: shell, batchBytes: whole };
  let bytes = batchBytes({ ...shell, threads: [] });
  const kept = new Set<OrchestrationShellSnapshot["threads"][number]>();
  for (const thread of shell.threads.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    // One separating comma per thread over-counts the first by a byte, which
    // keeps the estimate on the safe side of the limit.
    const threadBytes = Buffer.byteLength(JSON.stringify(thread), "utf8") + 1;
    if (bytes + threadBytes > maxBatchBytes) break;
    bytes += threadBytes;
    kept.add(thread);
  }
  return {
    snapshot: { ...shell, threads: shell.threads.filter((thread) => kept.has(thread)) },
    batchBytes: bytes,
  };
}

/** The shell item for an empty batch, and that one-item batch's encoded size. */
function shellUpload(shell: OrchestrationShellSnapshot): {
  readonly item: ThreadReadCacheUpload;
  readonly batchBytes: number;
  readonly threadIds: ReadonlySet<string>;
} {
  const bounded = boundThreadReadCacheShell(shell);
  if (bounded.batchBytes > MAX_BATCH_BYTES) {
    throw new Error("Cloud thread index exceeds the upload limit.");
  }
  return {
    item: { kind: "shell", revision: shell.snapshotSequence, snapshot: bounded.snapshot },
    batchBytes: bounded.batchBytes,
    threadIds: new Set(bounded.snapshot.threads.map((thread) => thread.id)),
  };
}

/**
 * The row limits of `ThreadReadCacheShell`, without re-decoding the whole shell. The shell comes
 * from the projection query, whose rows are already decoded field by field, so re-validating it
 * cost a full schema walk (16 ms at 2,000 threads) per publish for no change in content; the
 * publisher test pins that the uploaded shell still decodes to the same value.
 */
export function checkThreadReadCacheShellLimits(
  shell: OrchestrationShellSnapshot,
): OrchestrationShellSnapshot {
  if (
    shell.projects.length > THREAD_READ_CACHE_SHELL_LIMITS.projects ||
    (shell.worktrees?.length ?? 0) > THREAD_READ_CACHE_SHELL_LIMITS.worktrees ||
    shell.threads.length > THREAD_READ_CACHE_SHELL_LIMITS.threads
  ) {
    throw new Error("Thread read cache shell exceeds its row limits");
  }
  return shell;
}

/** Only message display fields leave the node; attachment URLs and tool output do not. */
export function threadReadCacheContent(
  messages: ReadonlyArray<OrchestrationMessage>,
): ThreadReadCacheContent {
  const saved: ThreadReadCacheContent["messages"][number][] = [];
  let bytes = 32;
  let characters = 0;
  for (const message of messages.slice(-150).toReversed()) {
    const item = {
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      turnId: message.turnId,
    };
    const size = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    // A single oversized message must not hide other recent readable messages.
    if (bytes + size > MAX_THREAD_BYTES || characters + item.text.length > 1_000_000) continue;
    bytes += size;
    characters += item.text.length;
    saved.push(item);
  }
  return Schema.decodeUnknownSync(ThreadReadCacheContent)({ messages: saved.toReversed() });
}

/**
 * A single serialized publisher. A failed/ambiguous batch stays pending and is
 * retried with identical revisions. Reads never participate in relay readiness.
 */
export function createThreadReadCachePublisher(deps: ThreadReadCachePublisherDeps) {
  let nodeId: string | null = null;
  let generation: number | null = null;
  let publishedSequence = -1;
  let refreshedAt = 0;
  let shell: OrchestrationShellSnapshot | null = null;
  const uploadedVersions = new Map<string, string>();
  let pending: {
    items: ThreadReadCacheUpload[];
    versions: Map<string, string>;
    shellSequence: number | null;
    shellThreadIds: ReadonlySet<string> | null;
  } | null = null;
  /** The threads the last uploaded index lists. */
  let publishedThreadIds: ReadonlySet<string> = new Set();
  /**
   * The last batch re-uploaded the shell and left thread content out for lack
   * of room. A shell that fills most of a batch (a node with about 1.6k threads
   * or more) changes sequence on every tick while an agent streams, so without
   * this the content behind it never fit until activity stopped.
   */
  let shellCrowdedOutContent = false;
  let stopped = false;
  let running: Promise<void> | null = null;

  const reset = () => {
    generation = null;
    publishedSequence = -1;
    shell = null;
    pending = null;
    shellCrowdedOutContent = false;
    publishedThreadIds = new Set();
    uploadedVersions.clear();
  };
  const isCurrent = (expectedNode: string) => !stopped && deps.nodeId() === expectedNode;
  const synchronize = async () => {
    const currentNode = deps.nodeId();
    if (stopped || currentNode === null) return;
    if (nodeId !== currentNode) {
      nodeId = currentNode;
      reset();
    }
    if (generation === null) {
      const nextGeneration = await deps.begin();
      if (!isCurrent(currentNode)) return;
      generation = nextGeneration;
      refreshedAt = deps.now();
    }
    if (pending === null) {
      const sequence = await deps.readSequence();
      if (!isCurrent(currentNode)) return;
      const refresh = deps.now() - refreshedAt >= REFRESH_MS;
      if (shell === null || shell.snapshotSequence !== sequence || refresh) {
        shell = checkThreadReadCacheShellLimits(await deps.readShell());
        if (!isCurrent(currentNode)) return;
        if (refresh) {
          uploadedVersions.clear();
          publishedSequence = -1;
          refreshedAt = deps.now();
        }
      }
      const items: ThreadReadCacheUpload[] = [];
      const versions = new Map<string, string>();
      let shellSequence: number | null = null;
      let shellThreadIds: ReadonlySet<string> | null = null;
      let size = 2;
      const shellOutdated = publishedSequence !== shell.snapshotSequence;
      // An already published shell that crowded content out of the last batch
      // waits one batch for that content; the first shell never waits, since
      // the cloud index must exist before anything else is useful. Content in
      // such a batch is limited to threads the published index already lists.
      const shellYields = shellOutdated && shellCrowdedOutContent && publishedSequence !== -1;
      if (shellOutdated && !shellYields) {
        const upload = shellUpload(shell);
        items.push(upload.item);
        shellSequence = shell.snapshotSequence;
        shellThreadIds = upload.threadIds;
        size = upload.batchBytes;
      }
      let contentLeftOut = false;
      // Content only for threads the index this batch publishes (or the one already published)
      // lists: the Hub rejects any other body, and a rejection resets the whole cloud cache. The
      // bounded index can list fewer threads than the content window when projects and worktrees
      // crowd it.
      const indexedThreadIds = shellThreadIds ?? publishedThreadIds;
      const recentThreads = shell.threads
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_THREADS);
      const retainedIds = new Set(recentThreads.map((thread) => thread.id));
      for (const id of uploadedVersions.keys()) {
        if (!retainedIds.has(id as ThreadId)) uploadedVersions.delete(id);
      }
      for (const thread of recentThreads) {
        if (items.length >= 16) break;
        // Include turn state: older projections can leave updatedAt unchanged
        // between streamed deltas, but their global sequence still advances.
        const version =
          thread.session?.status === "running"
            ? `${thread.updatedAt}:${shell.snapshotSequence}`
            : thread.updatedAt;
        if (uploadedVersions.get(thread.id) === version) continue;
        if (!indexedThreadIds.has(thread.id)) continue;
        const detail = await deps.readThread(thread.id);
        if (!isCurrent(currentNode)) return;
        if (detail === null) continue;
        const item: ThreadReadCacheUpload = {
          kind: "thread",
          threadId: thread.id,
          revision: detail.revision,
          snapshot: threadReadCacheContent(detail.messages),
        };
        const itemSize = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
        if (size + itemSize > MAX_BATCH_BYTES) {
          contentLeftOut = true;
          break;
        }
        size += itemSize;
        items.push(item);
        versions.set(thread.id, version);
      }
      if (shellYields && items.length === 0) {
        // Nothing was waiting after all: the shell need not wait either.
        const upload = shellUpload(shell);
        items.push(upload.item);
        shellSequence = shell.snapshotSequence;
        shellThreadIds = upload.threadIds;
      }
      shellCrowdedOutContent = shellSequence !== null && contentLeftOut;
      if (items.length === 0) return;
      pending = { items, versions, shellSequence, shellThreadIds };
    }
    const batch = pending;
    await deps.upload(generation, batch.items);
    if (!isCurrent(currentNode)) return;
    if (batch.shellSequence !== null) publishedSequence = batch.shellSequence;
    if (batch.shellThreadIds !== null) publishedThreadIds = batch.shellThreadIds;
    for (const [id, version] of batch.versions) uploadedVersions.set(id, version);
    pending = null;
  };
  return {
    synchronize: () => {
      if (running !== null) return running;
      running = synchronize().finally(() => {
        running = null;
      });
      return running;
    },
    /** A generation conflict means another authorized publisher superseded us. */
    reset,
    stop: () => {
      stopped = true;
    },
  };
}
