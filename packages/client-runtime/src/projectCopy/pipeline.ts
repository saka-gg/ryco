/**
 * Moves one artifact from the source to the target in chunks, with several calls in flight on
 * each side: reads run ahead of the appends, and appends go out in offset order without waiting
 * for the one before to answer. The target takes an append that arrives a little early (A17b),
 * so the order calls reach it in does not matter.
 *
 * Bounds: at most {@link PROJECT_COPY_MAX_CHUNK_RPCS_PER_NODE} chunk calls per node (A7), and
 * at most {@link PROJECT_COPY_MAX_BYTES_IN_MEMORY} of chunk bytes held at once (A22), counting
 * every read in flight or waiting for its append and every append in flight. Nothing outlives a
 * run: it settles only after every call it made answered.
 *
 * Chunks are as large as both connections allow: {@link PROJECT_COPY_DIRECT_CHUNK_BYTES} when
 * both nodes are direct and announce it, else {@link PROJECT_COPY_CHUNK_BYTES}, which one relay
 * data frame holds.
 *
 * @module projectCopy/pipeline
 */
import {
  PROJECT_COPY_CHUNK_BYTES,
  PROJECT_COPY_DIRECT_CHUNK_BYTES,
} from "@ryco/contracts/project-copy";

import type { ProjectCopyTransport } from "./io.ts";

/** Chunk calls in flight per node (A7). */
export const PROJECT_COPY_MAX_CHUNK_RPCS_PER_NODE = 4;
/** Raw chunk bytes a copy holds at once (A22): read, waiting for their append, or appending. */
export const PROJECT_COPY_MAX_BYTES_IN_MEMORY = 4 * 1024 * 1024;

export interface ProjectCopyPipelineLimits {
  readonly chunkBytes: number;
  /** Chunks read or being read and not yet appended, plus appends in flight. */
  readonly maxChunksInMemory: number;
  readonly maxReadsInFlight: number;
  readonly maxAppendsInFlight: number;
  /** Reads and appends together: one node's cap when it is both source and target. */
  readonly maxCallsInFlight: number;
}

export interface ProjectCopyChunkSide {
  readonly transport: ProjectCopyTransport | undefined;
  /** The node's announced `maxChunkBytes`; absent on nodes that announce none. */
  readonly maxChunkBytes: number | undefined;
}

/**
 * The chunk size for one artifact: what both nodes announce, up to
 * {@link PROJECT_COPY_DIRECT_CHUNK_BYTES} when both are direct and
 * {@link PROJECT_COPY_CHUNK_BYTES} otherwise. A node that announces nothing takes the latter.
 */
export function projectCopyChunkBytes(input: {
  readonly source: ProjectCopyChunkSide;
  readonly target: ProjectCopyChunkSide;
}): number {
  const direct = input.source.transport === "direct" && input.target.transport === "direct";
  const cap = direct ? PROJECT_COPY_DIRECT_CHUNK_BYTES : PROJECT_COPY_CHUNK_BYTES;
  const announced = (side: ProjectCopyChunkSide) =>
    side.maxChunkBytes !== undefined && Number.isSafeInteger(side.maxChunkBytes)
      ? side.maxChunkBytes
      : PROJECT_COPY_CHUNK_BYTES;
  return Math.max(1, Math.min(cap, announced(input.source), announced(input.target)));
}

/** The limits for chunks of `chunkBytes`; `sameNode` when one node is source and target. */
export function projectCopyPipelineLimits(
  chunkBytes: number,
  sameNode = false,
): ProjectCopyPipelineLimits {
  const perNode = PROJECT_COPY_MAX_CHUNK_RPCS_PER_NODE;
  return {
    chunkBytes,
    maxChunksInMemory: Math.min(
      2 * perNode,
      Math.max(2, Math.floor(PROJECT_COPY_MAX_BYTES_IN_MEMORY / chunkBytes)),
    ),
    maxReadsInFlight: perNode,
    maxAppendsInFlight: perNode,
    maxCallsInFlight: sameNode ? perNode : 2 * perNode,
  };
}

/** A read from the source failed; `cause` is what it rejected with. */
export class ProjectCopyChunkReadError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("Reading a chunk from the source failed.");
    this.name = "ProjectCopyChunkReadError";
    this.cause = cause;
  }
}

export interface PumpProjectCopyChunksInput {
  readonly byteLength: number;
  /** The target holds every byte before it. */
  readonly start: number;
  readonly limits: ProjectCopyPipelineLimits;
  /** The chunk's base64. A rejection ends the run with a {@link ProjectCopyChunkReadError}. */
  readonly read: (offset: number, length: number) => Promise<string>;
  /** Resolves with the target's `receivedBytes`; a rejection ends the run with it as it is. */
  readonly append: (offset: number, dataBase64: string) => Promise<number>;
  /** Runs before a read goes out; throwing ends the run (the relay budget, A7). */
  readonly beforeRead?: ((length: number) => void) | undefined;
  /** Runs before an append goes out; throwing ends the run. */
  readonly beforeAppend?: ((length: number) => void) | undefined;
  /** The target holds every byte before `offset` (reported in order). */
  readonly onAcknowledged?: ((offset: number) => void) | undefined;
}

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

interface Pending<T> {
  readonly offset: number;
  readonly length: number;
  settled: Settled<T> | null;
  done: Promise<void>;
}

/**
 * Sends the artifact from `start` on. Resolves `"done"` once the target holds every byte, and
 * `"rebegin"` when an append answered with fewer bytes than it carried (ask the target where it
 * stands). Rejects with the first failure in offset order, after every call in flight answered.
 */
export async function pumpProjectCopyChunks(
  input: PumpProjectCopyChunksInput,
): Promise<"done" | "rebegin"> {
  const { byteLength, limits } = input;
  const reads: Array<Pending<string>> = [];
  const appends: Array<Pending<number>> = [];
  let nextRead = input.start;
  let wake: (() => void) | null = null;

  const track = <T>(offset: number, length: number, call: () => Promise<T>): Pending<T> => {
    const entry: Pending<T> = { offset, length, settled: null, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        entry.settled = { ok: true, value: await call() };
      } catch (error) {
        entry.settled = { ok: false, error };
      }
      const resume = wake;
      wake = null;
      resume?.();
    })();
    return entry;
  };
  const inFlight = <T>(entries: ReadonlyArray<Pending<T>>) =>
    entries.reduce((count, entry) => count + (entry.settled === null ? 1 : 0), 0);

  try {
    if (input.start >= byteLength) return "done";
    for (;;) {
      // Answers count in offset order: a later one waits for the ones before it.
      while (appends[0]?.settled) {
        const head = appends.shift()!;
        const settled = head.settled!;
        if (!settled.ok) throw settled.error;
        const end = head.offset + head.length;
        if (settled.value < end) return "rebegin";
        input.onAcknowledged?.(end);
        if (end >= byteLength) return "done";
      }
      let appending = inFlight(appends);
      let reading = inFlight(reads);
      // Chunks that were read go out in order, as soon as there is room for their append.
      while (
        reads[0]?.settled &&
        appending < limits.maxAppendsInFlight &&
        reading + appending < limits.maxCallsInFlight
      ) {
        const head = reads.shift()!;
        const settled = head.settled!;
        if (!settled.ok) throw new ProjectCopyChunkReadError(settled.error);
        input.beforeAppend?.(head.length);
        const data = settled.value;
        appends.push(track(head.offset, head.length, () => input.append(head.offset, data)));
        appending += 1;
      }
      // Read ahead while the memory bound and the source's cap allow.
      while (
        nextRead < byteLength &&
        reads.length + appending < limits.maxChunksInMemory &&
        reading < limits.maxReadsInFlight &&
        reading + appending < limits.maxCallsInFlight
      ) {
        const offset = nextRead;
        const length = Math.min(limits.chunkBytes, byteLength - offset);
        input.beforeRead?.(length);
        reads.push(track(offset, length, () => input.read(offset, length)));
        nextRead += length;
        reading += 1;
      }
      // Something is in flight here: every path above that leaves nothing running returned.
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    wake = null;
    await Promise.all([...reads, ...appends].map((entry) => entry.done));
  }
}
