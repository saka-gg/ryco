import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type EnvironmentId,
  type ThreadId,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createChatFileUploadEngine,
  deriveChatFileUploadSendBlock,
  isChatFileUploadBlocking,
  isFileUploadTokenUsable,
  resolveFileUploadMaxBytes,
  type ChatFileUploadRecord,
  type ChatFileUploadStatus,
  type ChatFileUploadTransport,
} from "./attachmentUpload.ts";

const THREAD_ID = "thread-1" as ThreadId;
const ENV_ID = "env-1" as EnvironmentId;
const FUTURE = new Date(Date.now() + 10 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 10 * 60 * 1000).toISOString();

function makeTransport(overrides?: Partial<ChatFileUploadTransport>): ChatFileUploadTransport & {
  createFileUploadUrl: ReturnType<typeof vi.fn>;
  transferBytes: ReturnType<typeof vi.fn>;
} {
  return {
    createFileUploadUrl: vi.fn(async () => ({
      uploadToken: "token-1",
      expiresAt: FUTURE,
      maxUploadBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    })),
    transferBytes: vi.fn(async ({ onProgress }) => {
      onProgress?.(0.5);
      return { name: "file.bin", mimeType: "application/octet-stream", sizeBytes: 10 };
    }),
    ...overrides,
  };
}

function makeRequest(
  overrides?: Partial<Parameters<ReturnType<typeof createChatFileUploadEngine>["enqueue"]>[0]>,
) {
  return {
    attachmentId: "att-1",
    threadId: THREAD_ID,
    environmentId: ENV_ID,
    name: "file.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 10,
    readBytes: () => new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("upload pure helpers", () => {
  it("treats tokens near expiry as unusable", () => {
    const now = Date.now();
    expect(isFileUploadTokenUsable(new Date(now + 10 * 60_000).toISOString(), now)).toBe(true);
    expect(isFileUploadTokenUsable(new Date(now + 10_000).toISOString(), now)).toBe(false);
    expect(isFileUploadTokenUsable(new Date(now - 10_000).toISOString(), now)).toBe(false);
    expect(isFileUploadTokenUsable("not-a-date", now)).toBe(false);
  });

  it("resolves the streaming limit from the capability", () => {
    expect(
      resolveFileUploadMaxBytes({ fileAttachments: { maxUploadBytes: 25 * 1024 * 1024 } }),
    ).toBe(25 * 1024 * 1024);
    expect(
      resolveFileUploadMaxBytes({ fileAttachments: { maxUploadBytes: 500 * 1024 * 1024 } }),
    ).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
    expect(resolveFileUploadMaxBytes(undefined)).toBeNull();
    expect(resolveFileUploadMaxBytes({})).toBeNull();
    expect(resolveFileUploadMaxBytes({ fileAttachments: { maxUploadBytes: 0 } })).toBeNull();
  });

  it("classifies blocking statuses", () => {
    expect(isChatFileUploadBlocking(undefined)).toBe(false);
    expect(isChatFileUploadBlocking({ kind: "pending" })).toBe(true);
    expect(isChatFileUploadBlocking({ kind: "uploading", progress: 0.2 })).toBe(true);
    expect(isChatFileUploadBlocking({ kind: "failed", retryable: true, message: "x" })).toBe(true);
    expect(
      isChatFileUploadBlocking({ kind: "uploaded", uploadToken: "t", expiresAt: FUTURE }),
    ).toBe(false);
    expect(isChatFileUploadBlocking({ kind: "needsReattach", message: "x" })).toBe(false);
  });
});

describe("upload engine", () => {
  it.each(["release", "releaseAll"] as const)("ignores completion after %s", async (release) => {
    const transfer = Promise.withResolvers<{}>();
    const transport = makeTransport({ transferBytes: vi.fn(() => transfer.promise) });
    const engine = createChatFileUploadEngine(transport);
    engine.enqueue(makeRequest());
    await flushMicrotasks();
    if (release === "release") engine.release("att-1");
    else engine.releaseAll();
    transfer.resolve({});
    await flushMicrotasks();
    expect(engine.snapshot().size).toBe(0);
  });

  it("does not transfer bytes or restore errors after release during token minting", async () => {
    const mint =
      Promise.withResolvers<Awaited<ReturnType<ChatFileUploadTransport["createFileUploadUrl"]>>>();
    const transport = makeTransport({ createFileUploadUrl: vi.fn(() => mint.promise) });
    const engine = createChatFileUploadEngine(transport);
    engine.enqueue(makeRequest());
    engine.release("att-1");
    mint.resolve({ uploadToken: "old", expiresAt: FUTURE, maxUploadBytes: 1024 });
    await flushMicrotasks();
    expect(transport.transferBytes).not.toHaveBeenCalled();
    expect(engine.get("att-1")).toBeNull();
  });

  it("does not overwrite a replacement with a stale upload failure", async () => {
    const transfer = Promise.withResolvers<{}>();
    const transport = makeTransport({
      transferBytes: vi.fn().mockReturnValueOnce(transfer.promise).mockResolvedValue({}),
    });
    const engine = createChatFileUploadEngine(transport);
    engine.enqueue(makeRequest());
    await flushMicrotasks();
    engine.release("att-1");
    engine.enqueue(makeRequest({ name: "replacement.txt" }));
    transfer.reject(new Error("old transfer failed"));
    await flushMicrotasks();
    expect(engine.get("att-1")?.name).toBe("replacement.txt");
    expect(engine.get("att-1")?.status.kind).toBe("uploaded");
  });

  it("ignores retry while an upload is active", async () => {
    const transfer = Promise.withResolvers<{}>();
    const transport = makeTransport({ transferBytes: vi.fn(() => transfer.promise) });
    const engine = createChatFileUploadEngine(transport);
    engine.enqueue(makeRequest());
    await flushMicrotasks();
    engine.retry("att-1");
    expect(engine.get("att-1")?.status.kind).toBe("uploading");
    transfer.resolve({});
    await flushMicrotasks();
    expect(transport.createFileUploadUrl).toHaveBeenCalledTimes(1);
  });

  it("moves an attachment pending → uploading → uploaded and reports progress", async () => {
    const transport = makeTransport();
    const engine = createChatFileUploadEngine(transport);
    const seen: ChatFileUploadStatus[] = [];
    engine.subscribe(() => {
      const record = engine.get("att-1");
      if (record) seen.push(record.status);
    });

    engine.enqueue(makeRequest());
    await flushMicrotasks();

    expect(seen.some((status) => status.kind === "pending")).toBe(true);
    expect(seen.some((status) => status.kind === "uploading" && status.progress === 0)).toBe(true);
    expect(seen.some((status) => status.kind === "uploading" && status.progress === 0.5)).toBe(
      true,
    );
    const record = engine.get("att-1");
    expect(record?.status).toEqual({ kind: "uploaded", uploadToken: "token-1", expiresAt: FUTURE });
    expect(transport.createFileUploadUrl).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      environmentId: ENV_ID,
      threadId: THREAD_ID,
      name: "file.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 10,
    });
  });

  it("marks a token-mint failure as retryable and retries it", async () => {
    const transport = makeTransport({
      createFileUploadUrl: vi
        .fn()
        .mockRejectedValueOnce(new Error("server busy"))
        .mockResolvedValue({ uploadToken: "token-2", expiresAt: FUTURE, maxUploadBytes: 1024 }),
    });
    const engine = createChatFileUploadEngine(transport);

    engine.enqueue(makeRequest());
    await flushMicrotasks();
    expect(engine.get("att-1")?.status).toEqual({
      kind: "failed",
      retryable: true,
      message: "server busy",
    });

    engine.retry("att-1");
    await flushMicrotasks();
    expect(engine.get("att-1")?.status).toEqual({
      kind: "uploaded",
      uploadToken: "token-2",
      expiresAt: FUTURE,
    });
  });

  it("marks a transfer failure as retryable", async () => {
    const transport = makeTransport({
      transferBytes: vi.fn(async ({ onProgress }) => {
        onProgress?.(0.1);
        throw new Error("disk full");
      }),
    });
    const engine = createChatFileUploadEngine(transport);

    engine.enqueue(makeRequest());
    await flushMicrotasks();
    expect(engine.get("att-1")?.status).toEqual({
      kind: "failed",
      retryable: true,
      message: "disk full",
    });
    expect(transport.createFileUploadUrl).toHaveBeenCalledTimes(1);

    engine.retry("att-1");
    await flushMicrotasks();
    expect(transport.createFileUploadUrl).toHaveBeenCalledTimes(2);
  });

  it("runs uploads one at a time from the queue", async () => {
    const pendingTransfers: Array<(value: { name: string }) => void> = [];
    const transport = makeTransport({
      transferBytes: vi.fn(
        ({ onProgress: _onProgress }) =>
          new Promise((resolve) => {
            pendingTransfers.push(resolve);
          }),
      ) as never,
    });
    const engine = createChatFileUploadEngine(transport);

    engine.enqueue(makeRequest({ attachmentId: "a" }));
    engine.enqueue(makeRequest({ attachmentId: "b" }));
    await flushMicrotasks();

    expect(transport.transferBytes).toHaveBeenCalledTimes(1);
    pendingTransfers[0]!({ name: "a" });
    await flushMicrotasks();
    expect(transport.transferBytes).toHaveBeenCalledTimes(2);
    pendingTransfers[1]!({ name: "b" });
    await flushMicrotasks();
    expect(engine.get("a")?.status.kind).toBe("uploaded");
    expect(engine.get("b")?.status.kind).toBe("uploaded");
  });

  it("seeds uploaded records and demotes expired tokens to needsReattach", () => {
    const engine = createChatFileUploadEngine(makeTransport(), { nowMs: () => Date.now() });
    engine.seedUploaded({
      attachmentId: "a",
      threadId: THREAD_ID,
      environmentId: ENV_ID,
      name: "a.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 1,
      uploadToken: "tok",
      expiresAt: FUTURE,
    });
    expect(engine.get("a")?.status.kind).toBe("uploaded");

    engine.seedUploaded({
      attachmentId: "b",
      threadId: THREAD_ID,
      environmentId: ENV_ID,
      name: "b.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 1,
      uploadToken: "tok",
      expiresAt: PAST,
    });
    expect(engine.get("b")?.status.kind).toBe("needsReattach");
  });

  it("seedNeedsReattach does not clobber an uploaded record", () => {
    const engine = createChatFileUploadEngine(makeTransport());
    engine.seedUploaded({
      attachmentId: "a",
      threadId: THREAD_ID,
      environmentId: ENV_ID,
      name: "a.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 1,
      uploadToken: "tok",
      expiresAt: FUTURE,
    });
    engine.seedNeedsReattach("a");
    expect(engine.get("a")?.status.kind).toBe("uploaded");

    engine.seedNeedsReattach("b");
    expect(engine.get("b")?.status.kind).toBe("needsReattach");
  });

  it("verifyUsable demotes expired uploads", () => {
    let now = Date.now();
    const engine = createChatFileUploadEngine(makeTransport(), { nowMs: () => now });
    engine.seedUploaded({
      attachmentId: "a",
      threadId: THREAD_ID,
      environmentId: ENV_ID,
      name: "a.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 1,
      uploadToken: "tok",
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    expect(engine.verifyUsable("a", now)).toBe(true);
    now += 10 * 60_000;
    expect(engine.verifyUsable("a", now)).toBe(false);
    expect(engine.get("a")?.status.kind).toBe("needsReattach");
  });

  it("release drops the record and its queued work; releaseAll clears everything", async () => {
    const pendingTransfers: Array<(value: { name: string }) => void> = [];
    const transport = makeTransport({
      transferBytes: vi.fn(
        () =>
          new Promise((resolve) => {
            pendingTransfers.push(resolve);
          }),
      ) as never,
    });
    const engine = createChatFileUploadEngine(transport);

    engine.enqueue(makeRequest({ attachmentId: "a" }));
    engine.enqueue(makeRequest({ attachmentId: "b" }));
    engine.release("b");
    await flushMicrotasks();
    pendingTransfers[0]!({ name: "a" });
    await flushMicrotasks();

    expect(engine.get("b")).toBeNull();
    expect(transport.transferBytes).toHaveBeenCalledTimes(1);
    expect(engine.get("a")?.status.kind).toBe("uploaded");

    engine.releaseAll();
    expect(engine.snapshot().size).toBe(0);
  });
});

describe("deriveChatFileUploadSendBlock", () => {
  function recordWith(status: ChatFileUploadStatus): ChatFileUploadRecord {
    const request = makeRequest();
    return { ...request, status };
  }

  it("blocks while an attachment is uploading", () => {
    const records = new Map([["att-1", recordWith({ kind: "uploading", progress: 0.3 })]]);
    const result = deriveChatFileUploadSendBlock({
      attachmentIds: ["att-1"],
      getRecord: (id) => records.get(id) ?? null,
      nowMs: Date.now(),
    });
    expect(result.blockReason).toContain("file.bin");
  });

  it("blocks with a retry hint on failure and reattach hint on needsReattach", () => {
    const records = new Map([
      ["att-1", recordWith({ kind: "failed", retryable: true, message: "x" })],
      ["att-2", recordWith({ kind: "needsReattach", message: "x" })],
    ]);
    expect(
      deriveChatFileUploadSendBlock({
        attachmentIds: ["att-1"],
        getRecord: (id) => records.get(id) ?? null,
        nowMs: Date.now(),
      }).blockReason,
    ).toContain("failed to upload");
    expect(
      deriveChatFileUploadSendBlock({
        attachmentIds: ["att-2"],
        getRecord: (id) => records.get(id) ?? null,
        nowMs: Date.now(),
      }).blockReason,
    ).toContain("Attach");
  });

  it("blocks an expired token and passes fresh ones", () => {
    const now = Date.now();
    const records = new Map([
      [
        "att-1",
        recordWith({
          kind: "uploaded",
          uploadToken: "tok",
          expiresAt: new Date(now - 1).toISOString(),
        }),
      ],
      [
        "att-2",
        recordWith({
          kind: "uploaded",
          uploadToken: "tok",
          expiresAt: new Date(now + 10 * 60_000).toISOString(),
        }),
      ],
    ]);
    expect(
      deriveChatFileUploadSendBlock({
        attachmentIds: ["att-1"],
        getRecord: (id) => records.get(id) ?? null,
        nowMs: now,
      }).blockReason,
    ).toContain("Attach");
    expect(
      deriveChatFileUploadSendBlock({
        attachmentIds: ["att-2"],
        getRecord: (id) => records.get(id) ?? null,
        nowMs: now,
      }).blockReason,
    ).toBeNull();
  });

  it("ignores attachments without records", () => {
    expect(
      deriveChatFileUploadSendBlock({
        attachmentIds: ["missing"],
        getRecord: () => null,
        nowMs: Date.now(),
      }).blockReason,
    ).toBeNull();
  });
});

function readinessHarness() {
  const generations = new Map<EnvironmentId, object | null>([[ENV_ID, {}]]);
  const listeners = new Map<EnvironmentId, Set<() => void>>();
  return {
    watchReadiness: (id: EnvironmentId, onChange: () => void) => {
      const set = listeners.get(id) ?? new Set<() => void>();
      listeners.set(id, set);
      set.add(onChange);
      return {
        read: () => generations.get(id) ?? null,
        dispose: () => {
          set.delete(onChange);
        },
      };
    },
    set(id: EnvironmentId, ready: boolean) {
      generations.set(id, ready ? {} : null);
      for (const listener of listeners.get(id) ?? []) listener();
    },
    notify() {
      for (const set of listeners.values()) for (const listener of set) listener();
    },
    listenerCount: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
  };
}

describe("upload reconnect recovery", () => {
  it("does not repeat an in-flight upload that succeeds after reconnect", async () => {
    const readiness = readinessHarness();
    const transfer = Promise.withResolvers<{}>();
    const transport = makeTransport({ transferBytes: vi.fn(() => transfer.promise) });
    const engine = createChatFileUploadEngine(transport, readiness);
    engine.enqueue(makeRequest());
    await flushMicrotasks();
    readiness.set(ENV_ID, false);
    readiness.set(ENV_ID, true);
    transfer.resolve({});
    await flushMicrotasks();
    expect(engine.get("att-1")?.status.kind).toBe("uploaded");
    expect(transport.transferBytes).toHaveBeenCalledTimes(1);
    expect(readiness.listenerCount()).toBe(0);
    engine.releaseAll();
  });

  it("replaces a retained source without inheriting the old recovery budget", async () => {
    const readiness = readinessHarness();
    const first = Promise.withResolvers<{}>();
    const transport = makeTransport({
      transferBytes: vi.fn().mockReturnValueOnce(first.promise).mockRejectedValue(new Error("503")),
    });
    const engine = createChatFileUploadEngine(transport, readiness);
    engine.enqueue(makeRequest());
    await flushMicrotasks();
    readiness.set(ENV_ID, false);
    readiness.set(ENV_ID, true);
    const replacementSource = vi.fn(() => new Uint8Array([9]));
    engine.enqueue(makeRequest({ name: "replacement.txt", readBytes: replacementSource }));
    first.reject(new Error("stale"));
    await flushMicrotasks();
    expect(engine.get("att-1")?.name).toBe("replacement.txt");
    expect(engine.get("att-1")?.status.kind).toBe("failed");
    expect(replacementSource).toHaveBeenCalledTimes(1);
    expect(transport.transferBytes).toHaveBeenCalledTimes(2);
    expect(readiness.listenerCount()).toBe(1);
    engine.releaseAll();
    expect(readiness.listenerCount()).toBe(0);
  });

  it.each([false, true])(
    "retries once per recovery with failure after reconnect=%s",
    async (late) => {
      const readiness = readinessHarness();
      const first = Promise.withResolvers<{}>();
      const source = vi.fn(() => new Uint8Array([4, 5, 6]));
      const transport = makeTransport({
        transferBytes: vi
          .fn()
          .mockReturnValueOnce(first.promise)
          .mockRejectedValue(new Error("503")),
      });
      const engine = createChatFileUploadEngine(transport, readiness);
      engine.enqueue(makeRequest({ readBytes: source }));
      await flushMicrotasks();
      readiness.set(ENV_ID, false);
      if (late) readiness.set(ENV_ID, true);
      first.reject(new Error("interrupted"));
      await flushMicrotasks();
      if (!late) {
        expect(engine.get("att-1")?.readBytes).toBe(source);
        expect(source).toHaveBeenCalledTimes(1);
        readiness.set(ENV_ID, true);
      }
      await flushMicrotasks();
      expect(transport.transferBytes).toHaveBeenCalledTimes(2);
      expect(source).toHaveBeenCalledTimes(2);
      readiness.notify();
      await flushMicrotasks();
      expect(transport.transferBytes).toHaveBeenCalledTimes(2);
      expect(engine.get("att-1")?.status.kind).toBe("failed");
      // A later recovery gets a new bounded attempt. Success ends observation.
      transport.transferBytes.mockResolvedValue({});
      readiness.set(ENV_ID, false);
      readiness.set(ENV_ID, true);
      await flushMicrotasks();
      expect(transport.transferBytes).toHaveBeenCalledTimes(3);
      expect(engine.get("att-1")?.status.kind).toBe("uploaded");
      expect(readiness.listenerCount()).toBe(0);
      readiness.set(ENV_ID, false);
      readiness.set(ENV_ID, true);
      engine.retry("att-1");
      await flushMicrotasks();
      expect(transport.transferBytes).toHaveBeenCalledTimes(3);
    },
  );

  it("isolates environments and does not spin on failure without a recovery", async () => {
    const readiness = readinessHarness();
    const transport = makeTransport({ transferBytes: vi.fn().mockRejectedValue(new Error("503")) });
    const engine = createChatFileUploadEngine(transport, readiness);
    engine.enqueue(makeRequest());
    await flushMicrotasks();
    readiness.set("other" as EnvironmentId, false);
    readiness.set("other" as EnvironmentId, true);
    for (let i = 0; i < 10; i++) readiness.notify();
    await flushMicrotasks();
    expect(transport.createFileUploadUrl).toHaveBeenCalledTimes(1);
    expect(engine.get("att-1")?.status.kind).toBe("failed");
    engine.releaseAll();
  });

  it.each(["release", "releaseAll", "replace", "reattach"] as const)(
    "cancels a scheduled recovery on %s",
    async (action) => {
      const readiness = readinessHarness();
      const transport = makeTransport({
        transferBytes: vi.fn().mockRejectedValue(new Error("503")),
      });
      const engine = createChatFileUploadEngine(transport, readiness);
      engine.enqueue(makeRequest());
      await flushMicrotasks();
      readiness.set(ENV_ID, false);
      readiness.set(ENV_ID, true);
      if (action === "release") engine.release("att-1");
      if (action === "releaseAll") engine.releaseAll();
      if (action === "reattach") engine.seedNeedsReattach("att-1");
      if (action === "replace")
        engine.seedUploaded({ ...makeRequest(), uploadToken: "restored", expiresAt: FUTURE });
      await flushMicrotasks();
      expect(transport.transferBytes).toHaveBeenCalledTimes(1);
      expect(readiness.listenerCount()).toBe(0);
      engine.releaseAll();
    },
  );

  it("coalesces manual retry with automatic retry and keeps one transfer active", async () => {
    const readiness = readinessHarness();
    const retry = Promise.withResolvers<{}>();
    const transport = makeTransport({
      transferBytes: vi.fn().mockRejectedValueOnce(new Error("503")).mockReturnValue(retry.promise),
    });
    const engine = createChatFileUploadEngine(transport, readiness);
    engine.enqueue(makeRequest());
    await flushMicrotasks();
    readiness.set(ENV_ID, false);
    readiness.set(ENV_ID, true);
    engine.retry("att-1");
    engine.retry("att-1");
    await flushMicrotasks();
    expect(transport.transferBytes).toHaveBeenCalledTimes(2);
    retry.reject(new Error("still failing"));
    await flushMicrotasks();
    readiness.notify();
    await flushMicrotasks();
    expect(transport.transferBytes).toHaveBeenCalledTimes(2);
    engine.releaseAll();
  });

  it("checks current readiness when queued work finally gets a slot", async () => {
    const readiness = readinessHarness();
    const otherId = "other" as EnvironmentId;
    readiness.set(otherId, true);
    const blocker = Promise.withResolvers<{}>();
    const transport = makeTransport({
      transferBytes: vi
        .fn()
        .mockRejectedValueOnce(new Error("503"))
        .mockReturnValueOnce(blocker.promise)
        .mockResolvedValue({}),
    });
    const engine = createChatFileUploadEngine(transport, readiness);
    engine.enqueue(makeRequest());
    await flushMicrotasks();
    engine.enqueue(makeRequest({ attachmentId: "blocker", environmentId: otherId }));
    await flushMicrotasks();
    readiness.set(ENV_ID, false);
    readiness.set(ENV_ID, true);
    await flushMicrotasks();
    readiness.set(ENV_ID, false);
    blocker.resolve({});
    await flushMicrotasks();
    expect(transport.transferBytes).toHaveBeenCalledTimes(2);
    readiness.set(ENV_ID, true);
    await flushMicrotasks();
    expect(transport.transferBytes).toHaveBeenCalledTimes(3);
    engine.releaseAll();
  });

  it.each(["mint", "read"] as const)("fences a stale generation during %s", async (stage) => {
    const readiness = readinessHarness();
    const gate = Promise.withResolvers<void>();
    const transport = makeTransport({
      createFileUploadUrl: vi.fn(async () => {
        if (stage === "mint") await gate.promise;
        return { uploadToken: "token", expiresAt: FUTURE, maxUploadBytes: 1024 };
      }),
    });
    const engine = createChatFileUploadEngine(transport, readiness);
    engine.enqueue(
      makeRequest({
        readBytes: async () => {
          if (stage === "read") await gate.promise;
          return new Uint8Array([1]);
        },
      }),
    );
    await flushMicrotasks();
    readiness.set(ENV_ID, false);
    gate.resolve();
    await flushMicrotasks();
    expect(transport.transferBytes).not.toHaveBeenCalled();
    expect(engine.get("att-1")?.status.kind).toBe("failed");
    readiness.set(ENV_ID, true);
    await flushMicrotasks();
    expect(transport.transferBytes).toHaveBeenCalledTimes(1);
    engine.releaseAll();
  });

  it("disposes late watcher initialization after teardown", async () => {
    const setup = Promise.withResolvers<{ read: () => object; dispose: () => void }>();
    const dispose = vi.fn();
    const transport = makeTransport();
    const engine = createChatFileUploadEngine(transport, { watchReadiness: () => setup.promise });
    engine.enqueue(makeRequest());
    engine.releaseAll();
    setup.resolve({ read: () => ({}), dispose });
    await flushMicrotasks();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(transport.createFileUploadUrl).not.toHaveBeenCalled();
  });

  it("never resumes persisted or expired tokens even when local bytes once existed", async () => {
    const readiness = readinessHarness();
    const transport = makeTransport();
    const engine = createChatFileUploadEngine(transport, readiness);
    engine.enqueue(makeRequest());
    await flushMicrotasks();
    engine.verifyUsable("att-1", Date.parse(FUTURE));
    engine.seedNeedsReattach("reloaded");
    engine.seedUploaded({
      ...makeRequest({ attachmentId: "persisted" }),
      uploadToken: "old",
      expiresAt: PAST,
    });
    readiness.set(ENV_ID, false);
    readiness.set(ENV_ID, true);
    await flushMicrotasks();
    expect(transport.transferBytes).toHaveBeenCalledTimes(1);
    expect(
      [...engine.snapshot().values()].every((record) => record.status.kind === "needsReattach"),
    ).toBe(true);
    engine.releaseAll();
  });
});
