import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createEnvironmentConnection } from "../../connection/connection.ts";
import { createKnownEnvironment } from "../../knownEnvironment.ts";
import type { WsRpcClient } from "../../rpc/wsRpcClient.ts";
import {
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../../rpc/wsConnectionState.ts";
import { createChatFileUploadEngine, deriveChatFileUploadSendBlock } from "./attachmentUpload.ts";
import { watchDirectChatFileUploadReadiness } from "./attachmentUploadReadiness.ts";

const environmentId = EnvironmentId.make("recovery-env");
const request = {
  attachmentId: "file",
  environmentId,
  threadId: ThreadId.make("thread"),
  name: "file.txt",
  mimeType: "text/plain",
  sizeBytes: 1,
  readBytes: () => new Uint8Array([1]),
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(resetWsConnectionStateForTests);

function harness() {
  let shell!: Parameters<WsRpcClient["orchestration"]["subscribeShell"]>[0];
  let resubscribe: (() => void) | undefined;
  const connection = createEnvironmentConnection({
    kind: "primary",
    knownEnvironment: {
      ...createKnownEnvironment({
        id: environmentId,
        label: "test",
        source: "manual",
        target: { httpBaseUrl: "http://test.invalid", wsBaseUrl: "ws://test.invalid" },
      }),
      environmentId,
    },
    client: {
      orchestration: {
        subscribeShell: (listener, options) => {
          shell = listener;
          resubscribe = options?.onResubscribe;
          return () => {};
        },
      },
      terminal: { onEvent: () => () => {} },
      dispose: async () => {},
    } as unknown as WsRpcClient,
    pushSequenceMonitor: { recordEvent: () => {}, recordSnapshot: () => {} },
    syncShellSnapshot: () => {},
    resetShellProjection: () => {},
    applyShellEvent: () => {},
    applyTerminalEvent: () => {},
  });
  const transport = {
    createFileUploadUrl: vi.fn(async () => ({
      uploadToken: "test",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      maxUploadBytes: 1024,
    })),
    transferBytes: vi.fn(async () => ({})),
  };
  let current: typeof connection | null = connection;
  let allowed = true;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const engine = createChatFileUploadEngine(transport, {
    watchReadiness: (id, onChange) =>
      watchDirectChatFileUploadReadiness({
        environmentId: id,
        onChange,
        readConnection: () => current,
        canUpload: () => allowed,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      }),
  });
  return {
    connection,
    engine,
    transport,
    authorize: (value: boolean) => {
      allowed = value;
      notify();
    },
    remove: () => {
      current = null;
      notify();
    },
    open: () => {
      recordWsConnectionAttempt("ws://test.invalid", { environmentId });
      recordWsConnectionOpened({ environmentId });
    },
    snapshot: () =>
      shell({
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 1,
          projects: [],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      } as Parameters<typeof shell>[0]),
    resubscribe: () => resubscribe?.(),
    dispose: async () => {
      engine.releaseAll();
      await connection.dispose();
    },
  };
}

describe("upload recovery review regressions", () => {
  it("exposes an actionable error instead of an indefinite pending upload while disconnected", async () => {
    const h = harness();
    try {
      h.engine.enqueue(request);
      await flush();
      expect(h.engine.get("file")?.status.kind).toBe("failed");
      expect(
        deriveChatFileUploadSendBlock({
          attachmentIds: ["file"],
          getRecord: h.engine.get,
          nowMs: Date.now(),
        }).blockReason,
      ).not.toContain("Uploading");
      expect(h.transport.createFileUploadUrl).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  });

  it("cannot reuse a resolved shell promise when socket open precedes resubscribe", async () => {
    const h = harness();
    try {
      h.open();
      h.snapshot();
      await h.connection.ensureBootstrapped();
      h.transport.transferBytes.mockRejectedValueOnce(new Error("interrupted"));
      h.engine.enqueue(request);
      await flush();
      expect(h.transport.createFileUploadUrl).toHaveBeenCalledTimes(1);
      recordWsConnectionClosed({}, { environmentId });
      h.open();
      // Deliberately do NOT reset the shell gate. This is the review's race.
      await flush();
      expect(h.transport.createFileUploadUrl).toHaveBeenCalledTimes(1);
      h.resubscribe();
      await flush();
      expect(h.transport.createFileUploadUrl).toHaveBeenCalledTimes(1);
      h.snapshot();
      await flush();
      expect(h.transport.createFileUploadUrl).toHaveBeenCalledTimes(2);
      expect(h.engine.get("file")?.status.kind).toBe("uploaded");
    } finally {
      await h.dispose();
    }
  });
  it.each(["auth", "removed", "exhausted"] as const)(
    "fails an unavailable environment (%s) without minting or spinning",
    async (reason) => {
      const h = harness();
      try {
        h.open();
        h.snapshot();
        if (reason === "auth") h.authorize(false);
        if (reason === "removed") h.remove();
        if (reason === "exhausted") {
          for (let i = 0; i < 10; i++)
            recordWsConnectionAttempt("ws://test.invalid", { environmentId });
          recordWsConnectionClosed({}, { environmentId });
        }
        h.engine.enqueue(request);
        await flush();
        expect(h.engine.get("file")?.status).toMatchObject({
          kind: "failed",
          retryable: true,
          message: expect.stringMatching(/Reconnect|authorize/),
        });
        h.engine.retry("file");
        await flush();
        expect(h.engine.get("file")?.status.kind).toBe("failed");
        expect(h.transport.createFileUploadUrl).not.toHaveBeenCalled();
        if (reason === "auth") {
          h.authorize(true);
          await flush();
          expect(h.transport.transferBytes).toHaveBeenCalledTimes(1);
        }
      } finally {
        await h.dispose();
      }
    },
  );

  it("allows an offline enqueue to recover once a current snapshot is accepted", async () => {
    const h = harness();
    try {
      h.engine.enqueue(request);
      await flush();
      expect(h.engine.get("file")?.status.kind).toBe("failed");
      h.open();
      await flush();
      expect(h.transport.createFileUploadUrl).not.toHaveBeenCalled();
      h.snapshot();
      await flush();
      expect(h.engine.get("file")?.status.kind).toBe("uploaded");
      expect(h.transport.createFileUploadUrl).toHaveBeenCalledTimes(1);
    } finally {
      await h.dispose();
    }
  });

  it("fences a newly enqueued upload in the reopen-before-resubscribe window too", async () => {
    const h = harness();
    try {
      h.open();
      h.snapshot();
      await h.connection.ensureBootstrapped();
      recordWsConnectionClosed({}, { environmentId });
      h.open();
      h.engine.enqueue(request);
      await flush();
      expect(h.transport.createFileUploadUrl).not.toHaveBeenCalled();
      h.resubscribe();
      h.snapshot();
      await flush();
      expect(h.transport.transferBytes).toHaveBeenCalledTimes(1);
    } finally {
      await h.dispose();
    }
  });

  it.each(["auth", "removed", "exhausted"] as const)(
    "cancels a hanging transfer on %s and ignores its late completion",
    async (reason) => {
      const h = harness();
      const transfer = Promise.withResolvers<{}>();
      try {
        h.open();
        h.snapshot();
        h.transport.transferBytes.mockReturnValueOnce(transfer.promise);
        h.engine.enqueue(request);
        await flush();
        const signal = (
          h.transport.transferBytes.mock.calls[0] as unknown as [{ signal: AbortSignal }]
        )[0].signal;
        if (reason === "auth") h.authorize(false);
        if (reason === "removed") h.remove();
        if (reason === "exhausted") {
          for (let i = 0; i < 10; i++)
            recordWsConnectionAttempt("ws://test.invalid", { environmentId });
          recordWsConnectionClosed({}, { environmentId });
        }
        await flush();
        expect(signal.aborted).toBe(true);
        expect(h.engine.get("file")?.status.kind).toBe("failed");
        transfer.resolve({});
        await flush();
        expect(h.engine.get("file")?.status.kind).toBe("failed");
        if (reason === "auth") {
          h.authorize(true);
          await flush();
          expect(h.engine.get("file")?.status.kind).toBe("uploaded");
          expect(h.transport.transferBytes).toHaveBeenCalledTimes(2);
        }
      } finally {
        await h.dispose();
      }
    },
  );

  it.each(["mint", "read", "transfer"] as const)(
    "releases a cancelled %s slot before the abandoned operation settles",
    async (stage) => {
      const h = harness();
      const gate = Promise.withResolvers<void>();
      try {
        h.open();
        h.snapshot();
        if (stage === "mint")
          h.transport.createFileUploadUrl.mockImplementationOnce(async () => {
            await gate.promise;
            return {
              uploadToken: "abandoned",
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
              maxUploadBytes: 1024,
            };
          });
        if (stage === "transfer")
          h.transport.transferBytes.mockImplementationOnce(async () => {
            await gate.promise;
            return {};
          });
        h.engine.enqueue({
          ...request,
          readBytes: async () => {
            if (stage === "read") await gate.promise;
            return new Uint8Array([1]);
          },
        });
        await flush();
        h.engine.enqueue({ ...request, attachmentId: "next", name: "next.txt" });
        h.engine.release("file");
        await flush();
        expect(h.engine.get("next")?.status.kind).toBe("uploaded");
        const calls = h.transport.transferBytes.mock.calls.length;
        gate.resolve();
        await flush();
        expect(h.engine.get("file")).toBeNull();
        expect(h.transport.transferBytes).toHaveBeenCalledTimes(calls);
      } finally {
        await h.dispose();
      }
    },
  );

  it("does not grant another retry for duplicate snapshots in the same ready generation", async () => {
    const h = harness();
    try {
      h.open();
      h.snapshot();
      h.transport.transferBytes.mockRejectedValue(new Error("503"));
      h.engine.enqueue(request);
      await flush();
      h.snapshot();
      h.snapshot();
      await flush();
      expect(h.transport.transferBytes).toHaveBeenCalledTimes(1);
    } finally {
      await h.dispose();
    }
  });
  it("exposes an interrupted active transfer after recovery and lets Retry replace it", async () => {
    const h = harness();
    const transfer = Promise.withResolvers<{}>();
    try {
      h.open();
      h.snapshot();
      h.transport.transferBytes.mockReturnValueOnce(transfer.promise);
      h.engine.enqueue(request);
      await flush();
      recordWsConnectionClosed({}, { environmentId });
      h.open();
      h.resubscribe();
      h.snapshot();
      await flush();
      expect(h.engine.get("file")?.status).toMatchObject({
        kind: "failed",
        label: "Interrupted",
        retryable: true,
      });
      expect(h.transport.transferBytes).toHaveBeenCalledTimes(1);
      h.engine.retry("file");
      await flush();
      expect(h.engine.get("file")?.status.kind).toBe("uploaded");
      expect(h.transport.transferBytes).toHaveBeenCalledTimes(2);
      transfer.resolve({});
      await flush();
      h.snapshot();
      await flush();
      expect(h.transport.transferBytes).toHaveBeenCalledTimes(2);
    } finally {
      await h.dispose();
    }
  });
  it("does not publish an already-resolved transfer after synchronous authorization revocation", async () => {
    const h = harness();
    const transfer = Promise.withResolvers<{}>();
    try {
      h.open();
      h.snapshot();
      h.transport.transferBytes.mockReturnValueOnce(transfer.promise);
      h.engine.enqueue(request);
      await flush();
      transfer.resolve({});
      h.authorize(false);
      await flush();
      expect(h.engine.get("file")?.status.kind).toBe("failed");
    } finally {
      await h.dispose();
    }
  });
  it.each(["mint", "read"] as const)(
    "does not advance a resolved %s after cancellation and immediate reauthorization",
    async (stage) => {
      const h = harness();
      const minted = {
        uploadToken: "cancelled",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        maxUploadBytes: 1024,
      };
      const mint = Promise.withResolvers<typeof minted>();
      const read = Promise.withResolvers<Uint8Array>();
      const readBytes = vi.fn(() => new Uint8Array([1]) as Uint8Array | Promise<Uint8Array>);
      try {
        h.open();
        h.snapshot();
        if (stage === "mint") h.transport.createFileUploadUrl.mockReturnValueOnce(mint.promise);
        else readBytes.mockReturnValueOnce(read.promise);
        h.engine.enqueue({ ...request, readBytes });
        await flush();
        if (stage === "mint") mint.resolve(minted);
        else read.resolve(new Uint8Array([1]));
        h.authorize(false);
        h.authorize(true);
        await flush();
        expect(h.engine.get("file")?.status.kind).toBe("uploaded");
        expect(h.transport.transferBytes).toHaveBeenCalledTimes(1);
        expect(readBytes).toHaveBeenCalledTimes(stage === "mint" ? 1 : 2);
      } finally {
        await h.dispose();
      }
    },
  );
});
