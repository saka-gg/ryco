import { MessageId, OrchestrationShellSnapshot, type OrchestrationMessage } from "@ryco/contracts";
import { Schema } from "effect";
import { ThreadReadCacheShell } from "@ryco/contracts/thread-read-cache";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  boundThreadReadCacheShell,
  checkThreadReadCacheShellLimits,
  createThreadReadCachePublisher,
  threadReadCacheContent,
  type ThreadReadCacheUpload,
} from "./ThreadReadCachePublisher.ts";

const time = "2026-10-04T00:00:00.000Z";
function shell(count = 1, sequence = 1, updatedAt: (index: number) => string = () => time) {
  return Schema.decodeUnknownSync(OrchestrationShellSnapshot)({
    snapshotSequence: sequence,
    updatedAt: time,
    projects: [],
    threads: Array.from({ length: count }, (_, index) => ({
      id: `thread-${index}`,
      projectId: "project-1",
      title: "Thread",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: time,
      updatedAt: updatedAt(index),
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    })),
  });
}
function message(id: number, text = `Message ${id}`): OrchestrationMessage {
  return {
    id: MessageId.make(`message-${id}`),
    role: "assistant",
    text,
    turnId: null,
    streaming: true,
    createdAt: time,
    updatedAt: time,
  };
}
function harness(count = 1) {
  let snapshot = shell(count);
  let node: string | null = "node-1";
  const upload = vi.fn(
    async (_generation: number, _items: ReadonlyArray<ThreadReadCacheUpload>) => undefined,
  );
  const begin = vi.fn(async () => 1);
  const readThread = vi.fn(async () => ({
    revision: snapshot.snapshotSequence,
    messages: [message(1)],
  }));
  const publisher = createThreadReadCachePublisher({
    nodeId: () => node,
    now: Date.now,
    readSequence: async () => snapshot.snapshotSequence,
    readShell: async () => snapshot,
    readThread,
    begin,
    upload,
  });
  return {
    publisher,
    upload,
    begin,
    readThread,
    setShell: (next: typeof snapshot) => {
      snapshot = next;
    },
    setNode: (next: string | null) => {
      node = next;
    },
  };
}

describe("cloud thread history publisher", () => {
  it("backfills in bounded batches and makes no network writes for unchanged nodes", async () => {
    const h = harness(20);
    await h.publisher.synchronize();
    expect(h.upload.mock.calls[0]?.[1]).toHaveLength(16);
    await h.publisher.synchronize();
    expect(h.upload.mock.calls[1]?.[1]).toHaveLength(5);
    await h.publisher.synchronize();
    expect(h.upload).toHaveBeenCalledTimes(2);
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.readThread).toHaveBeenCalledTimes(20);
  });

  it("retries ambiguous delivery byte-for-byte before publishing newer revisions", async () => {
    const h = harness();
    h.upload.mockRejectedValueOnce(new Error("response lost"));
    await expect(h.publisher.synchronize()).rejects.toThrow("response lost");
    h.setShell(shell(0, 2));
    await h.publisher.synchronize();
    expect(h.upload.mock.calls[1]).toEqual(h.upload.mock.calls[0]);
    await h.publisher.synchronize();
    expect(h.upload.mock.calls[2]?.[1]).toEqual([
      { kind: "shell", revision: 2, snapshot: shell(0, 2) },
    ]);
  });

  it("serializes concurrent synchronization and never uploads a read completed after stop", async () => {
    const h = harness();
    let release!: (value: { revision: number; messages: OrchestrationMessage[] }) => void;
    h.readThread.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = h.publisher.synchronize();
    const second = h.publisher.synchronize();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(h.readThread).toHaveBeenCalledTimes(1));
    h.publisher.stop();
    release({ revision: 1, messages: [message(1)] });
    await first;
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("starts a new generation when enrollment changes and does nothing offline", async () => {
    const h = harness();
    h.setNode(null);
    await h.publisher.synchronize();
    expect(h.begin).not.toHaveBeenCalled();
    h.setNode("node-1");
    await h.publisher.synchronize();
    h.setNode("node-2");
    await h.publisher.synchronize();
    expect(h.begin).toHaveBeenCalledTimes(2);
    expect(h.upload).toHaveBeenCalledTimes(2);
  });

  it("bounds an oversized shell to its most recently updated threads instead of failing", () => {
    const recentFirst = (index: number) =>
      new Date(Date.parse(time) - index * 60_000).toISOString();
    const full = shell(40, 7, recentFirst);
    const whole = boundThreadReadCacheShell(full);
    expect(whole.snapshot).toBe(full);
    expect(whole.batchBytes).toBe(
      Buffer.byteLength(JSON.stringify([{ kind: "shell", revision: 7, snapshot: full }]), "utf8"),
    );

    const limit = Math.floor(whole.batchBytes / 2);
    const bounded = boundThreadReadCacheShell(full, limit);
    expect(bounded.batchBytes).toBeLessThanOrEqual(limit);
    expect(
      Buffer.byteLength(
        JSON.stringify([{ kind: "shell", revision: 7, snapshot: bounded.snapshot }]),
        "utf8",
      ),
    ).toBeLessThanOrEqual(limit);
    const kept = bounded.snapshot.threads.map((thread) => thread.id);
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.length).toBeLessThan(40);
    // The newest threads, in their original order.
    expect(kept).toEqual(full.threads.slice(0, kept.length).map((thread) => thread.id));
    // Still a valid read-cache shell.
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationShellSnapshot)(bounded.snapshot),
    ).not.toThrow();
  });

  it("publishes a node whose shell exceeds one batch", async () => {
    const test = harness(1);
    test.setShell(shell(6_000, 2));
    await test.publisher.synchronize();
    const items = test.upload.mock.calls[0]![1];
    const uploaded = items.find((item) => item.kind === "shell");
    expect(uploaded?.kind === "shell" && uploaded.snapshot.threads.length).toBeGreaterThan(0);
    expect(uploaded?.kind === "shell" && uploaded.snapshot.threads.length).toBeLessThan(6_000);
    expect(Buffer.byteLength(JSON.stringify(items), "utf8")).toBeLessThanOrEqual(
      2 * 1024 * 1024 - 4096,
    );
  });

  it("lets thread content through while a shell larger than one batch keeps changing", async () => {
    const test = harness(1);
    test.readThread.mockImplementation(async () => ({
      revision: 1,
      messages: [message(1, "x".repeat(20_000))],
    }));
    const kinds = (call: number) => test.upload.mock.calls[call]![1].map((item) => item.kind);
    const threadIds = (call: number) =>
      test.upload.mock.calls[call]![1].flatMap((item) =>
        item.kind === "thread" ? [item.threadId] : [],
      );
    // Equal timestamps keep creation order, so the bounded index holds the
    // first threads and the newest-first content order starts with them too.
    const newest = (index: number) => (index === 6_000 ? "2026-10-05T00:00:00.000Z" : time);

    test.setShell(shell(6_000, 2));
    await test.publisher.synchronize();
    // The first index never waits; it fills the batch.
    expect(kinds(0)).toEqual(["shell"]);

    // Activity changes the shell before every tick. The re-upload waits one
    // batch for the content it crowded out, and that batch carries only
    // threads the published index already names (not the new thread-6000).
    test.setShell(shell(6_001, 3, newest));
    await test.publisher.synchronize();
    expect(kinds(1)).not.toContain("shell");
    expect(threadIds(1).length).toBeGreaterThan(0);
    expect(threadIds(1)).not.toContain("thread-6000");

    test.setShell(shell(6_001, 4, newest));
    await test.publisher.synchronize();
    expect(kinds(2)[0]).toBe("shell");
    const indexed = test.upload.mock.calls[2]![1][0];
    expect(
      indexed?.kind === "shell" && indexed.snapshot.threads.some((t) => t.id === "thread-6000"),
    ).toBe(true);
  });

  it("never uploads a thread body the bounded index does not list", async () => {
    const test = harness(1);
    // Like the Hub: a thread body must be listed by the shell in its batch, or else by the
    // last uploaded shell (node_conflict otherwise, which resets the whole cloud cache).
    let indexed = new Set<string>();
    test.upload.mockImplementation(async (_generation, items) => {
      const shellItem = items.find((item) => item.kind === "shell");
      const listed =
        shellItem?.kind === "shell"
          ? new Set<string>(shellItem.snapshot.threads.map((thread) => thread.id))
          : indexed;
      for (const item of items) {
        if (item.kind === "thread" && !listed.has(item.threadId)) {
          throw new Error(`node_conflict: ${item.threadId} is not indexed`);
        }
      }
      indexed = listed;
    });
    // Wide shell rows: the bounded index keeps fewer threads than the 512-thread content window.
    const wide = shell(600, 2);
    test.setShell({
      ...wide,
      threads: wide.threads.map((thread) =>
        Object.assign({}, thread, { title: "T".repeat(6_000) }),
      ),
    });
    for (let tick = 0; tick < 60; tick += 1) await test.publisher.synchronize();

    expect(indexed.size).toBeGreaterThan(16);
    expect(indexed.size).toBeLessThan(512);
    const uploadedThreads = new Set(
      test.upload.mock.calls.flatMap(([, items]) =>
        items.flatMap((item) => (item.kind === "thread" ? [item.threadId] : [])),
      ),
    );
    // Every indexed thread's content was published, and nothing else.
    expect(uploadedThreads).toEqual(indexed);
  });

  it("does not hold the index back when no crowded-out content is left to send", async () => {
    const test = harness(1);
    test.readThread.mockImplementation(async () => ({
      revision: 1,
      messages: [message(1, "x".repeat(20_000))],
    }));
    test.setShell(shell(6_000, 2));
    await test.publisher.synchronize();
    // Every crowded-out thread is gone from the next index: nothing to send
    // but the index itself.
    test.setShell(shell(0, 3));
    await test.publisher.synchronize();
    expect(test.upload.mock.calls[1]![1]).toEqual([
      { kind: "shell", revision: 3, snapshot: shell(0, 3) },
    ]);
  });

  it("keeps readable history when the newest message exceeds the projection limit", () => {
    const content = threadReadCacheContent([
      message(1, "Readable previous message"),
      message(2, "a".repeat(1_100_000)),
    ]);
    expect(content.messages.map((entry) => entry.id)).toEqual(["message-1"]);
  });

  it("bounds history and UTF-8 bytes and strips live/attachment fields", () => {
    const content = threadReadCacheContent(Array.from({ length: 160 }, (_, i) => message(i)));
    expect(content.messages).toHaveLength(150);
    expect(content.messages[0]?.id).toBe("message-10");
    expect(content.messages[0]).not.toHaveProperty("streaming");
    expect(content.messages[0]).not.toHaveProperty("updatedAt");
    const large = threadReadCacheContent([
      message(1, "a".repeat(900_000)),
      message(2, "😀".repeat(200_000)),
    ]);
    expect(large.messages.map((entry) => entry.id)).toEqual(["message-2"]);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(1024 * 1024);
  });

  it("publishes a shell the Hub decodes to the same value, without re-decoding it", async () => {
    const { upload, publisher } = harness(3);
    await publisher.synchronize();
    const shellItem = upload.mock.calls[0]![1].find((item) => item.kind === "shell")!;
    // The wire item keeps its shape: kind, revision and the shell snapshot.
    expect(Object.keys(shellItem).toSorted()).toEqual(["kind", "revision", "snapshot"]);
    const wire = JSON.parse(JSON.stringify(shellItem.snapshot)) as unknown;
    const decoded = Schema.decodeUnknownSync(ThreadReadCacheShell)(wire);
    expect(JSON.parse(JSON.stringify(decoded))).toEqual(wire);
  });

  it("refuses a shell over the cache's row limits like the schema did", () => {
    const tooMany = {
      ...shell(1),
      threads: Array.from({ length: 10_001 }, () => shell(1).threads[0]!),
    };
    expect(() => checkThreadReadCacheShellLimits(tooMany)).toThrow(/row limits/);
    expect(() => Schema.decodeUnknownSync(ThreadReadCacheShell)(tooMany)).toThrow();
    expect(checkThreadReadCacheShellLimits(shell(2))).toEqual(shell(2));
  });
});
