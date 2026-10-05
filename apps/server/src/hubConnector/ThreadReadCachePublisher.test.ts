import { MessageId, OrchestrationShellSnapshot, type OrchestrationMessage } from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createThreadReadCachePublisher,
  threadReadCacheContent,
  type ThreadReadCacheUpload,
} from "./ThreadReadCachePublisher.ts";

const time = "2026-10-04T00:00:00.000Z";
function shell(count = 1, sequence = 1) {
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
      updatedAt: time,
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
});
