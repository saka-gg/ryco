import {
  PROJECT_COPY_CHUNK_BYTES,
  PROJECT_COPY_DIRECT_CHUNK_BYTES,
} from "@ryco/contracts/project-copy";
import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_COPY_MAX_BYTES_IN_MEMORY,
  PROJECT_COPY_MAX_CHUNK_RPCS_PER_NODE,
  ProjectCopyChunkReadError,
  projectCopyChunkBytes,
  projectCopyPipelineLimits,
  pumpProjectCopyChunks,
  type ProjectCopyPipelineLimits,
} from "./pipeline.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** The fake data of the chunk at `offset` (its content is not checked here). */
const dataOf = (offset: number) => `chunk-${offset}`;

/**
 * A source and a target the test answers by hand: every call waits until the test resolves it,
 * so the order and timing of answers are the test's.
 */
class ManualIo {
  readonly reads: Array<{ offset: number; length: number; answer: Deferred<string> }> = [];
  readonly appends: Array<{ offset: number; data: string; answer: Deferred<number> }> = [];
  readsInFlight = 0;
  appendsInFlight = 0;
  maxReadsInFlight = 0;
  maxAppendsInFlight = 0;
  maxCallsInFlight = 0;
  /** Chunks held: read or being read and not yet appended, or being appended. */
  held = 0;
  maxHeld = 0;
  received = 0;
  readonly acknowledged: number[] = [];

  private track() {
    this.maxReadsInFlight = Math.max(this.maxReadsInFlight, this.readsInFlight);
    this.maxAppendsInFlight = Math.max(this.maxAppendsInFlight, this.appendsInFlight);
    this.maxCallsInFlight = Math.max(
      this.maxCallsInFlight,
      this.readsInFlight + this.appendsInFlight,
    );
    this.maxHeld = Math.max(this.maxHeld, this.held);
  }

  readonly read = (offset: number, length: number): Promise<string> => {
    const answer = deferred<string>();
    this.reads.push({ offset, length, answer });
    this.readsInFlight += 1;
    this.held += 1;
    this.track();
    return answer.promise.then(
      (value) => {
        this.readsInFlight -= 1;
        return value;
      },
      (error: unknown) => {
        this.readsInFlight -= 1;
        this.held -= 1;
        throw error;
      },
    );
  };

  readonly append = (offset: number, data: string): Promise<number> => {
    const answer = deferred<number>();
    this.appends.push({ offset, data, answer });
    this.appendsInFlight += 1;
    this.track();
    return answer.promise.finally(() => {
      this.appendsInFlight -= 1;
      this.held -= 1;
    });
  };

  /** Answers every read asked for so far. */
  answerReads() {
    for (const read of this.reads.splice(0)) read.answer.resolve(dataOf(read.offset));
  }

  /** Answers the appends asked for so far, in `order` ("fifo" or "lifo"), as a target would. */
  answerAppends(length: (offset: number) => number, order: "fifo" | "lifo" = "fifo") {
    const pending = this.appends.splice(0);
    if (order === "lifo") pending.reverse();
    for (const append of pending) {
      // A real target writes them in offset order whatever order they arrived in.
      this.received = Math.max(this.received, append.offset + length(append.offset));
      append.answer.resolve(append.offset + length(append.offset));
    }
  }
}

const limits = (overrides: Partial<ProjectCopyPipelineLimits> = {}): ProjectCopyPipelineLimits => ({
  chunkBytes: 10,
  maxChunksInMemory: 6,
  maxReadsInFlight: 4,
  maxAppendsInFlight: 4,
  maxCallsInFlight: 8,
  ...overrides,
});

/** Drives the manual IO until `run` settles, answering reads and appends each turn. */
async function drive(
  io: ManualIo,
  run: Promise<"done" | "rebegin">,
  options: {
    readonly byteLength: number;
    readonly chunkBytes: number;
    readonly order?: "fifo" | "lifo";
  },
) {
  const state = { settled: false };
  void run.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  const length = (offset: number) => Math.min(options.chunkBytes, options.byteLength - offset);
  for (let turn = 0; turn < 1_000 && !state.settled; turn += 1) {
    await tick();
    io.answerReads();
    await tick();
    io.answerAppends(length, options.order);
  }
  return run;
}

describe("pumpProjectCopyChunks", () => {
  it("keeps several appends in flight, in offset order, within its bounds", async () => {
    const io = new ManualIo();
    const run = pumpProjectCopyChunks({
      byteLength: 95,
      start: 0,
      limits: limits(),
      read: io.read,
      append: io.append,
      onAcknowledged: (offset) => io.acknowledged.push(offset),
    });
    const result = await drive(io, run, { byteLength: 95, chunkBytes: 10 });
    expect(result).toBe("done");
    expect(io.acknowledged).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 95]);
    expect(io.maxAppendsInFlight).toBe(4);
    expect(io.maxReadsInFlight).toBeLessThanOrEqual(4);
    expect(io.maxHeld).toBeLessThanOrEqual(6);
  });

  it("acknowledges in offset order when the target answers out of order", async () => {
    const io = new ManualIo();
    const appendOffsets: number[] = [];
    const run = pumpProjectCopyChunks({
      byteLength: 80,
      start: 0,
      limits: limits(),
      read: io.read,
      append: (offset, data) => {
        appendOffsets.push(offset);
        return io.append(offset, data);
      },
      onAcknowledged: (offset) => io.acknowledged.push(offset),
    });
    expect(await drive(io, run, { byteLength: 80, chunkBytes: 10, order: "lifo" })).toBe("done");
    // Sent in order, acknowledged in order.
    expect(appendOffsets).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
    expect(io.acknowledged).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it("starts from the target's receivedBytes", async () => {
    const io = new ManualIo();
    const run = pumpProjectCopyChunks({
      byteLength: 50,
      start: 30,
      limits: limits(),
      read: io.read,
      append: io.append,
      onAcknowledged: (offset) => io.acknowledged.push(offset),
    });
    expect(await drive(io, run, { byteLength: 50, chunkBytes: 10 })).toBe("done");
    expect(io.acknowledged).toEqual([40, 50]);
    expect(await pumpProjectCopyChunks({ ...baseInput(io), byteLength: 50, start: 50 })).toBe(
      "done",
    );
  });

  it("fails with the first failed append, only after every call in flight answered, and resumes", async () => {
    const io = new ManualIo();
    const failure = new Error("SocketCloseError");
    let failed = false;
    let settledWhileInFlight = false;
    const run = pumpProjectCopyChunks({
      byteLength: 100,
      start: 0,
      limits: limits(),
      read: io.read,
      append: io.append,
      onAcknowledged: (offset) => io.acknowledged.push(offset),
    });
    void run.catch(() => {
      if (io.appendsInFlight > 0 || io.readsInFlight > 0) settledWhileInFlight = true;
    });
    // Let the pipeline fill, then answer the third append with a failure and hold the fourth.
    for (let turn = 0; turn < 10 && io.appends.length < 4; turn += 1) {
      await tick();
      io.answerReads();
    }
    expect(io.appends.map((append) => append.offset)).toEqual([0, 10, 20, 30]);
    const [first, second, third, fourth] = io.appends.splice(0);
    first!.answer.resolve(10);
    second!.answer.resolve(20);
    third!.answer.reject(failure);
    io.received = 20;
    await tick();
    await tick();
    expect(io.acknowledged).toEqual([10, 20]);
    // Not settled yet: the fourth append is still out.
    void run.then(
      () => undefined,
      () => (failed = true),
    );
    await tick();
    expect(failed).toBe(false);
    // The target never got the third chunk, so the fourth fails with the gap.
    fourth!.answer.reject(Object.assign(new Error("gap"), { receivedBytes: 20 }));
    io.answerReads();
    await expect(run).rejects.toBe(failure);
    expect(settledWhileInFlight).toBe(false);
    expect(io.appendsInFlight).toBe(0);
    expect(io.readsInFlight).toBe(0);

    // Resumed from where the target stands.
    const resumed = new ManualIo();
    const again = pumpProjectCopyChunks({
      byteLength: 100,
      start: io.received,
      limits: limits(),
      read: resumed.read,
      append: resumed.append,
      onAcknowledged: (offset) => resumed.acknowledged.push(offset),
    });
    expect(await drive(resumed, again, { byteLength: 100, chunkBytes: 10 })).toBe("done");
    expect(resumed.acknowledged).toEqual([30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it("asks to begin again when an append answers with fewer bytes than it carried", async () => {
    const io = new ManualIo();
    const run = pumpProjectCopyChunks({ ...baseInput(io), byteLength: 40 });
    for (let turn = 0; turn < 10 && io.appends.length < 2; turn += 1) {
      await tick();
      io.answerReads();
    }
    const [first, ...rest] = io.appends.splice(0);
    first!.answer.resolve(0);
    for (const append of rest) append.answer.resolve(append.offset + 10);
    await tick();
    io.answerReads();
    await tick();
    io.answerAppends(() => 10);
    expect(await run).toBe("rebegin");
  });

  it("reports a failed read as a ProjectCopyChunkReadError, in its turn", async () => {
    const io = new ManualIo();
    const cause = Object.assign(new Error("expired"), { code: "expired" });
    const run = pumpProjectCopyChunks({ ...baseInput(io), byteLength: 40 });
    await tick();
    const [first, second, ...rest] = io.reads.splice(0);
    second!.answer.reject(cause);
    first!.answer.resolve(dataOf(0));
    for (const read of rest) read.answer.resolve(dataOf(read.offset));
    await tick();
    io.answerAppends(() => 10);
    const error = await run.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ProjectCopyChunkReadError);
    expect((error as ProjectCopyChunkReadError).cause).toBe(cause);
    // The chunk before the failed one went out.
    expect(io.received).toBe(10);
  });

  it("stops before a read the budget refuses and waits for the calls in flight", async () => {
    const io = new ManualIo();
    const refused = new Error("too large");
    let spent = 0;
    const run = pumpProjectCopyChunks({
      ...baseInput(io),
      byteLength: 100,
      beforeRead: (length) => {
        if (spent + length > 30) throw refused;
        spent += length;
      },
    });
    let settled = false;
    void run.catch(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    expect(io.reads).toHaveLength(3);
    io.answerReads();
    await expect(run).rejects.toBe(refused);
    expect(spent).toBe(30);
  });

  it("shares one node's cap between reads and appends when it is source and target", async () => {
    const io = new ManualIo();
    const run = pumpProjectCopyChunks({
      ...baseInput(io),
      byteLength: 200,
      limits: limits({ maxChunksInMemory: 8, maxCallsInFlight: 4 }),
    });
    expect(await drive(io, run, { byteLength: 200, chunkBytes: 10 })).toBe("done");
    expect(io.maxCallsInFlight).toBeLessThanOrEqual(4);
  });
});

function baseInput(io: ManualIo) {
  return {
    byteLength: 10,
    start: 0,
    limits: limits(),
    read: io.read,
    append: io.append,
    onAcknowledged: (offset: number) => io.acknowledged.push(offset),
  };
}

describe("projectCopyChunkBytes", () => {
  const direct = (maxChunkBytes?: number) => ({ transport: "direct" as const, maxChunkBytes });
  const relay = (maxChunkBytes?: number) => ({ transport: "relay" as const, maxChunkBytes });

  it("uses 1 MiB chunks only when both nodes are direct and announce them", () => {
    const big = PROJECT_COPY_DIRECT_CHUNK_BYTES;
    expect(projectCopyChunkBytes({ source: direct(big), target: direct(big) })).toBe(big);
    expect(projectCopyChunkBytes({ source: direct(big), target: relay(big) })).toBe(
      PROJECT_COPY_CHUNK_BYTES,
    );
    expect(projectCopyChunkBytes({ source: relay(big), target: direct(big) })).toBe(
      PROJECT_COPY_CHUNK_BYTES,
    );
    // A node that announces nothing (an older one) takes the relay-sized chunk.
    expect(projectCopyChunkBytes({ source: direct(big), target: direct() })).toBe(
      PROJECT_COPY_CHUNK_BYTES,
    );
    expect(projectCopyChunkBytes({ source: direct(), target: direct(big) })).toBe(
      PROJECT_COPY_CHUNK_BYTES,
    );
    // An unknown transport is not direct.
    expect(
      projectCopyChunkBytes({
        source: { transport: undefined, maxChunkBytes: big },
        target: direct(big),
      }),
    ).toBe(PROJECT_COPY_CHUNK_BYTES);
  });

  it("never passes what either node announces, nor the direct cap", () => {
    expect(projectCopyChunkBytes({ source: direct(512 * 1024), target: direct(2 ** 30) })).toBe(
      512 * 1024,
    );
    expect(projectCopyChunkBytes({ source: direct(2 ** 30), target: direct(2 ** 30) })).toBe(
      PROJECT_COPY_DIRECT_CHUNK_BYTES,
    );
    expect(projectCopyChunkBytes({ source: relay(64 * 1024), target: relay() })).toBe(64 * 1024);
  });
});

describe("projectCopyPipelineLimits", () => {
  it("holds at most the memory budget, and at most four chunk calls per node", () => {
    for (const chunkBytes of [PROJECT_COPY_CHUNK_BYTES, PROJECT_COPY_DIRECT_CHUNK_BYTES]) {
      const bounds = projectCopyPipelineLimits(chunkBytes);
      expect(bounds.maxChunksInMemory * chunkBytes).toBeLessThanOrEqual(
        PROJECT_COPY_MAX_BYTES_IN_MEMORY,
      );
      expect(bounds.maxReadsInFlight).toBe(PROJECT_COPY_MAX_CHUNK_RPCS_PER_NODE);
      expect(bounds.maxAppendsInFlight).toBe(PROJECT_COPY_MAX_CHUNK_RPCS_PER_NODE);
    }
    expect(projectCopyPipelineLimits(PROJECT_COPY_CHUNK_BYTES).maxChunksInMemory).toBe(8);
    expect(projectCopyPipelineLimits(PROJECT_COPY_DIRECT_CHUNK_BYTES).maxChunksInMemory).toBe(4);
    expect(projectCopyPipelineLimits(PROJECT_COPY_CHUNK_BYTES, true).maxCallsInFlight).toBe(
      PROJECT_COPY_MAX_CHUNK_RPCS_PER_NODE,
    );
  });
});
