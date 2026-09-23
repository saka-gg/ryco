import { EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "@ryco/client-runtime/rpc";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => {
  const generation = {};
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    listeners,
    runtime: { authState: "authenticated" },
    connection: {
      knownEnvironment: { source: "manual" },
      shellSnapshotReadiness: { read: () => generation, subscribe },
    },
    subscribe,
    mint: vi.fn(),
    transfer: vi.fn(),
  };
});

vi.mock("../runtime/bootstrap", () => ({
  createMobileConnectionRegistry: () => ({
    catalog: {
      get: () => ({ httpBaseUrl: "http://test.invalid" }),
      getRuntime: () => fixture.runtime,
      runtimeStore: { subscribe: fixture.subscribe },
      registryStore: { subscribe: fixture.subscribe },
    },
    driver: { supervisor: { read: () => fixture.connection, subscribe: fixture.subscribe } },
  }),
}));
vi.mock("../hostedHub/primaryEnvironment", () => ({ usePrimaryEnvironmentDescriptor: vi.fn() }));
vi.mock("../platform/attachmentUpload", () => ({
  mobileChatFileUploadTransport: {
    createFileUploadUrl: fixture.mint,
    transferBytes: fixture.transfer,
  },
}));

import { composerFileUploadEngine as engine } from "./composerFileUpload";

const environmentId = EnvironmentId.make("mobile-upload");
const metadata = { environmentId };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function connect() {
  recordWsConnectionAttempt("ws://test.invalid", metadata);
  recordWsConnectionOpened(metadata);
}

afterEach(() => {
  engine.releaseAll();
  resetWsConnectionStateForTests();
  fixture.runtime.authState = "authenticated";
  vi.resetAllMocks();
});

describe("mobile composer upload recovery binding", () => {
  it("waits for authorization on reconnect and releases its watches after success", async () => {
    fixture.mint.mockResolvedValue({
      uploadToken: "test",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      maxUploadBytes: 1024,
    });
    fixture.transfer.mockRejectedValueOnce(new Error("interrupted")).mockResolvedValue({});
    connect();
    engine.enqueue({
      attachmentId: "file",
      environmentId,
      threadId: ThreadId.make("thread"),
      name: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      readBytes: () => new Uint8Array([1]),
    });
    await flush();
    expect(engine.get("file")?.status.kind).toBe("failed");
    recordWsConnectionClosed({}, metadata);
    fixture.runtime.authState = "requires-auth";
    connect();
    await flush();
    expect(fixture.transfer).toHaveBeenCalledTimes(1);
    fixture.runtime.authState = "authenticated";
    for (const listener of fixture.listeners) listener();
    await flush();
    expect(engine.get("file")?.status.kind).toBe("uploaded");
    expect(fixture.transfer).toHaveBeenCalledTimes(2);
    expect(fixture.listeners.size).toBe(0);
  });
});
