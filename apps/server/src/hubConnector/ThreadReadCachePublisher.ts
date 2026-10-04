import { Schema } from "effect";
import type { OrchestrationShellSnapshot, OrchestrationMessage, ThreadId } from "@ryco/contracts";
import { ThreadReadCacheContent, ThreadReadCacheShell } from "@ryco/contracts/thread-read-cache";

const MAX_BATCH_BYTES = 2 * 1024 * 1024 - 4096;
const MAX_THREAD_BYTES = 1024 * 1024;
const MAX_THREADS = 512;
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
  } | null = null;
  let stopped = false;
  let running: Promise<void> | null = null;

  const reset = () => {
    generation = null;
    publishedSequence = -1;
    shell = null;
    pending = null;
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
        shell = Schema.decodeUnknownSync(ThreadReadCacheShell)(await deps.readShell());
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
      if (publishedSequence !== shell.snapshotSequence) {
        items.push({ kind: "shell", revision: shell.snapshotSequence, snapshot: shell });
        shellSequence = shell.snapshotSequence;
      }
      let size = Buffer.byteLength(JSON.stringify(items), "utf8");
      if (size > MAX_BATCH_BYTES) throw new Error("Cloud thread index exceeds the upload limit.");
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
        if (size + itemSize > MAX_BATCH_BYTES) break;
        size += itemSize;
        items.push(item);
        versions.set(thread.id, version);
      }
      if (items.length === 0) return;
      pending = { items, versions, shellSequence };
    }
    const batch = pending;
    await deps.upload(generation, batch.items);
    if (!isCurrent(currentNode)) return;
    if (batch.shellSequence !== null) publishedSequence = batch.shellSequence;
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
